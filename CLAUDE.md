# CLAUDE.md — Contexto de Proyecto grvt-grid

> Guía de arranque para sesiones de Claude Code. Lee esto primero.

## 1. Resumen del Proyecto

Bot de **grid trading** para futuros perpetuos en [GRVT](https://grvt.io) (exchange DEX on-chain). Objetivo del usuario: farmear el **airdrop de GRVT** (TGE ~finales junio 2026) mediante volumen maker + open interest.

- **Repo:** `grvt-grid` — monorepo TypeScript, licencia AGPL-3.0
- **Packages:**
  - `@grvt-grid/bot` — Motor de trading + REST API + WebSocket server (Node 22, Express 5, SQLite)
  - `@grvt-grid/dashboard` — SPA frontend (Vite + React 19 + Tailwind 4 + Recharts)
  - `@grvt-grid/notifier` — Sidecar de alertas Telegram (opcional, lee DB read-only)
- **Deploy:** VPS (hostname `TODOAI`), Docker container `grvt-grid-bot`, dashboard en `grvt.digilinkstore.com`
- **DB:** SQLite en `data/grid_bot.db` (montada como volumen Docker `./data:/app/data`)
- **Usuarios:** Multi-tenant — cada usuario tiene sus propias credenciales GRVT (cifradas AES-256-GCM en DB)

## 2. Arquitectura y Rutas Clave

```
grvt-grid/
├── packages/bot/src/
│   ├── api/
│   │   ├── client.ts          # Cliente GRVT: auth, órdenes, posiciones, specs de instrumentos
│   │   ├── auth.ts            # Firma EIP-712 para requests autenticados
│   │   ├── grvt-client-factory.ts  # Factory multi-tenant con cache LRU por usuario
│   │   └── order-signer.ts    # Firma de órdenes on-chain
│   ├── bot/
│   │   ├── grid-engine.ts     # ★ MOTOR PRINCIPAL — toda la lógica de grid trading
│   │   └── backtester.ts      # Backtesting con datos históricos
│   ├── database/
│   │   └── db.ts              # Capa de datos SQLite (callback-based, sqlite3 lib)
│   ├── dashboard/
│   │   └── server.ts          # Servidor Express + API legacy (/api/*)
│   ├── server/
│   │   ├── v2-router.ts       # API v2 (/api/v2/*) — auth JWT, CRUD completo
│   │   ├── v2-bootstrap.ts    # Monta WS + v2 router sobre el server Express
│   │   ├── ws-server.ts       # WebSocket server para updates en tiempo real
│   │   ├── ws-dispatcher.ts   # Dispatch de eventos del engine a clientes WS
│   │   └── logger.ts          # Pino logger
│   ├── auth/                  # bcrypt passwords, JWT, AES-GCM crypto
│   └── mail/                  # Password reset vía SMTP
├── packages/dashboard/src/
│   ├── pages/                 # overview, bots-list, bot-detail, backtest, settings, login/signup
│   ├── components/            # charts (equity-curve, grid-chart, liq-gauge), wizards, primitives
│   ├── stores/                # Zustand stores
│   ├── i18n/                  # Bilingüe ES/EN con toggle
│   └── lib/                   # api-client, auth-context, format helpers
├── packages/notifier/src/     # Telegram alerts: batched fills, drawdown, daily summary
├── data/                      # SQLite DB (bind-mount en Docker)
├── docker-compose.yml         # Stack: bot (always), notifier (profile: full), caddy (profile: full)
├── packages/bot/Dockerfile    # Multi-stage build (bot + dashboard + runtime slim)
└── scripts/                   # backup.sh, install.sh, logrotate.conf, grafana-dashboard.json
```

### DB — Tablas principales

| Tabla | Propósito |
|-------|-----------|
| `grid_bots` | Config de cada bot (par, leverage, rango, status, PnL, safeguards) |
| `grid_levels` | Niveles de grilla (precio, side, qty, order_id, is_filled, state) |
| `orders` | Historial de órdenes (INSERT OR IGNORE — idempotente) |
| `trades` | Fills con fee real de GRVT |
| `fills_archive` | Archivo de fills con INSERT OR IGNORE sobre `event_time` |
| `paired_roundtrips` | Pares buy→sell con profit calculado |
| `users` | Cuentas de usuario (bcrypt passwords) |
| `grvt_credentials` | Credenciales GRVT cifradas por usuario |
| `grvt_sub_accounts` | Sub-cuentas GRVT opcionales por usuario |

### Cómo arranca

1. Docker build → multi-stage (compila TS + build SPA)
2. `docker compose up -d` → container `grvt-grid-bot` en puerto 3848
3. Server Express arranca en `packages/bot/src/dashboard/server.ts` → llama `mountV2()` para WS + API v2
4. Bots en status `running` arrancan su monitor loop automáticamente

## 3. ⚠️ LECCIONES CRÍTICAS APRENDIDAS

> Estas costaron horas de debugging. NO repetir.

### 3.1 GRVT no tiene API para setear leverage

El endpoint `/set_leverage` devuelve **404**. El leverage se ajusta **manualmente en la UI de GRVT**. El bot debe LEER el leverage real de la posición y abortar si no coincide con el configurado.

- **Guard en `grid-engine.ts:~907-926`**: al arrancar un bot, lee `getPosition()` → `leverage`, compara con el config del bot, lanza error si hay mismatch.
- **Acción requerida:** Al crear/arrancar un bot, verificar SIEMPRE el leverage real en la UI de GRVT coincide con el del bot.

### 3.2 GRVT devuelve `order_id: "0x00"` en create_order

GRVT devuelve un placeholder `0x00...0` (64 ceros) como `order_id` al crear una orden. El order_id real solo aparece después en `open_orders`.

- **[0x00 FIX] en `grid-engine.ts:~2705-2740`**: tras crear la orden, espera 2s, consulta `getOpenOrders()`, matchea por precio con tolerancia + closest-match, y actualiza el order_id real.
- **Correspondencia:** Se usa `metadata.client_order_id` como vínculo. NO confiar solo en precio.

### 3.3 Truncamiento de precios por activo (EL bug que mató a ADA)

GRVT **acepta** órdenes con `tick_size` fino (ej. ADA tick=0.0001 → $0.2264), pero **devuelve** `limit_price` truncado en `open_orders` y `fills`. ADA: truncado a 2 decimales ($0.01 bucket).

Con spacing más fino que el bucket, **~5 niveles colapsan al mismo precio** → bucle infinito de re-place + duplicados.

- **ADA (muerto):** tick API 0.0001, responses truncados a $0.01 →_spacing $0.0018 < bucket $0.01 → colapso.
- **UNI (funciona):** responses preservan 3 decimales ($0.001 bucket) → spacing $0.017 > bucket → sin colapso.

**REGLA DE ORO para elegir activo / spacing:**

> Antes de configurar CUALQUIER par nuevo, VERIFICAR a cuántos decimales GRVT devuelve los precios: colocar 2-3 órdenes de prueba lejos del precio actual, leer `open_orders`, cancelar. El spacing de la grilla debe ser **≥ 1.5-2× el bucket real** de ese activo. Activos sub-dólar (ADA, FET) son peligrosos; activos de $2+ (UNI, RENDER, SOL) toleran bien.

### 3.4 NUNCA dejar el bot activo mientras se tocan órdenes

Cancelar/modificar órdenes manualmente con el bot corriendo causó un cruce de procesos que volteó una posición de long a short.

**REGLA:** `pausar bot → operar/cancelar → reiniciar`. Siempre secuencial.

### 3.5 Maintenance margin real de GRVT ≈ 1%

Empíricamente verificado con ADA: entry $0.23, leverage 10x → liquidación real a $0.209. El cálculo de maintenance margin es ~1%, no 0.5%.

- **Constante en `grid-engine.ts:336`**: `SAFEGUARD_MAINTENANCE_MARGIN = 0.01`
- **Función `computeLiqPriceLocal()`** en línea ~346: `factor = 1/leverage - 0.01`

### 3.6 INSERT de órdenes debe ser idempotente

`INSERT OR IGNORE` en `orders`, `fills_archive`, y `paired_roundtrips` para que reintentos/reposiciones no rompan con UNIQUE constraints. Implementado en `db.ts:~1195, 1390, 1649`.

### 3.7 Errores tragados en try/catch = fallos silenciosos

El bot reportó "running con N niveles" cuando las órdenes realmente fallaron. Toda colocación debe contar éxitos/fallos y reportar la verdad. Commits recientes mejoraron el logging de placeGridOrder.

### 3.8 Specs de instrumentos: cache + fallback

`instrumentSpecsCache` en `client.ts:~177` tiene specs hardcodeadas para pares conocidos (BTC, ETH, SOL, ADA) y un fallback genérico `{tick_size: 0.01}`. Para pares nuevos, las specs se obtienen de la API de GRVT en runtime (`getInstruments()`). Si la API falla, el fallback puede ser incorrecto — verificar.

### 3.9 GRVT solo soporta GOOD_TILL_TIME (no GTC real)

GRVT **no tiene** `GOOD_TILL_CANCEL`. Solo soporta `GOOD_TILL_TIME`, `IMMEDIATE_OR_CANCEL`, y `FILL_OR_KILL` (confirmado en `grvt-pysdk/grvt_raw_types.py`). Toda orden necesita un timestamp de expiración.

- **Constante en `order-signer.ts:85`**: `ORDER_EXPIRATION_HOURS = 168` (7 días)
- **Función `generateExpiration()`** en línea ~86: convierte horas a nanosegundos
- El `timeInForce` numérico `1` (GTC en EIP-712) se mapea a `'GOOD_TILL_TIME'` en `formatSignedOrderForAPI()` (línea ~316)
- **Antes era 24h** — causaba que órdenes expiraran diario sin que el bot lo supiera

### 3.10 El monitor NO debe asumir "filled" en el gap sin verificar

El monitor loop (`grid-engine.ts:~3048`) detecta niveles "uncovered" (sin orden en GRVT). Antes, el más cercano al precio se marcaba como `is_filled: true` **sin verificar si hubo fill real**. Cuando una orden expiraba (GOOD_TILL_TIME) en vez de ejecutarse, se perdía la oportunidad de compra/venta.

- **Fix**: Todos los niveles uncovered se verifican contra fill history (REST + WS archive) ANTES de decidir. Fill real → counter-order. Sin fill → re-colocar.
- **Todas las re-colocaciones** pasan por `placeGridOrder()` que hardcodea `post_only: true` (línea 2764) — maker rebate preservado.
- **Toda orden firmada** pasa por `signOrder()` → `generateExpiration()` → 7 días.

### 3.11 Commits de los fixes clave (git log)

```
e3136f6 fix(grid): 7-day order expiration + verify fills before marking gap
1c91e3a fix(grid): tick-based price matching + idempotent order inserts
839afe9 fix(grid): GRVT price truncation — order_id matching + wider tolerance
9da72a9 fix(grid): use list + closest-match for GRVT price bucket disambiguation
4631ba9 security: remove DASHBOARD_API_KEY from client bundle
86a959e security: fix 4 critical pre-launch issues (C-1..C-4)
633ae64 feat: H.8 Virtual Grids + SOL enablement + Apr 25 critical fixes
```

Ver `NOTES.md` para el análisis detallado del bug de ADA (causa raíz, 3 commits, 3 opciones de solución).

## 4. Estado Actual (Snapshot Junio 2026)

### Bot activo

| Campo | Valor |
|-------|-------|
| **ID** | 5 |
| **Par** | `UNI_USDT_Perp` |
| **Dirección** | long |
| **Leverage** | 4x |
| **Rango** | $2.56 – $3.41 |
| **Niveles** | 50 (+ 1 filled gap) |
| **Qty/nivel** | 5 UNI |
| **Inversión** | $200 |
| **Safeguard** | Enabled, 10%, action=pause |
| **Auto-shift** | Enabled |
| **Stop-loss** | ❌ No configurado (`sl_pct = null`) |

### Bots inactivos (historial)

- IDs 2, 3, 4 — todos `ADA_USDT_Perp`, todos `stopped`. El bot 4 fue el que sufrió el bug de truncamiento.

### Pendientes conocidos

- **Stop-loss sin configurar:** `sl_pct = null` en el bot activo. Solo el safeguard de liquidación (10%) protege. Considerar configurar SL o cambiar safeguard action a `pause_close`.
- **Leverage real sin verificar en esta sesión:** El container se reinició y los logs de startup no están disponibles. Verificar en UI de GRVT que la posición UNI muestra 4x.

## 5. Reglas de Operación

1. **Antes de tocar órdenes manualmente:** pausar el bot (`POST /api/v2/bots/5/pause` o dashboard). Nunca operar con el bot corriendo.
2. **Antes de configurar un par nuevo:** verificar el bucket de precios de GRVT (regla de oro en 3.3). Colocar órdenes de prueba, leer open_orders, cancelar.
3. **Commits chicos:** trabajar en pasos pequeños con commits frecuentes. El contexto de Claude se puede llenar y perder progreso.
4. **No commitear secretos:** `.env` está en `.gitignore`. Verificar antes de push.
5. **Verificar leverage real:** tras crear/arrancar un bot, confirmar en la UI de GRVT que el leverage coincide.
6. **Post-only siempre:** las órdenes de grilla se colocan con `post_only: true` (maker). No cambiar esto.
7. **No mezclar cambios en grid-engine.ts:** es el archivo más crítico y grande (~3500+ líneas). Los cambios deben ser quirúrgicos.

## 6. Comandos Útiles

### Docker (producción)

```bash
# Ver estado del container
docker ps -f name=grvt-grid-bot

# Reiniciar el bot
docker restart grvt-grid-bot

# Logs en tiempo real
docker logs -f grvt-grid-bot

# Últimas N líneas
docker logs --tail 200 grvt-grid-bot

# Logs filtrados (fills, errores, UNI)
docker logs grvt-grid-bot 2>&1 | grep -E 'fill|Fill|Error|UNI'

# Reconstruir tras cambios de código
docker compose build bot && docker compose up -d bot

# Health check
curl -s http://127.0.0.1:3848/api/health | python3 -m json.tool
```

### Consultas DB (dentro del container)

```bash
# Abrir shell de Node con acceso a DB
docker exec -it grvt-grid-bot node -e "
import Database from 'better-sqlite3';
const db = new Database('/app/data/grid_bot.db');
// Tu query aquí
console.log(db.prepare('SELECT ...').all());
db.close();
"

# Ejemplo: bots activos
docker exec grvt-grid-bot node -e "
import Database from 'better-sqlite3';
const db = new Database('/app/data/grid_bot.db');
console.log(db.prepare('SELECT id, pair, status, leverage, lower_price, upper_price FROM grid_bots').all());
db.close();
"

# Ejemplo: niveles de un bot
docker exec grvt-grid-bot node -e "
import Database from 'better-sqlite3';
const db = new Database('/app/data/grid_bot.db');
console.log(db.prepare('SELECT price, side, is_filled, state, order_id FROM grid_levels WHERE bot_id = 5 ORDER BY price').all());
db.close();
"
```

### Desarrollo local

```bash
# Instalar dependencias
npm install

# Build completo
npm run build

# Tests
npm run test                    # todos los packages
npm run test --workspace=@grvt-grid/bot  # solo bot

# Typecheck
npm run typecheck

# Dev server del bot (con hot reload)
npm run dev:bot

# Dev server del dashboard
npm run dev:dashboard
```

### API endpoints útiles (requieren auth JWT o API key)

```
GET  /api/health                  # Status del server (sin auth)
GET  /api/v2/bots                 # Lista de bots
GET  /api/v2/bots/:id             # Detalle de bot con PnL real
POST /api/v2/bots/:id/start       # Iniciar bot
POST /api/v2/bots/:id/pause       # Pausar bot
POST /api/v2/bots/:id/close       # Cerrar posición y detener
GET  /api/v2/bots/:id/orders      # Órdenes del bot
GET  /api/v2/bots/:id/trades      # Trades/fills del bot
GET  /api/v2/balance              # Balance de la cuenta GRVT
GET  /api/v2/prices               # Precios de mercado
```
