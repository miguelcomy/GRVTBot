# Bot 4 (ADA_USDT_Perp) — Estado y próximos pasos

## Causa raíz del problema

GRVT acepta órdenes con tick_size=0.0001 (ej. $0.2264) pero **devuelve `limit_price` truncado a 2 decimales** en `open_orders` y `fills` (ej. $0.23). Con el rango $0.185–$0.275 y 50 niveles (spacing $0.0018), ~5–6 niveles caen dentro de cada centavo:

```
$0.2264  ┐
$0.2282  │  todos → GRVT devuelve $0.23
$0.2300  │
$0.2318  │
$0.2336  ┘
```

Esto hace imposible desambiguar por precio solo. El monitor no puede saber si la orden a "$0.23" pertenece al nivel $0.2264, $0.2282, $0.2300, etc. Resultado: niveles no matcheados → re-place → duplicados → bucle infinito.

## Commits ya hechos (3)

### 1. `1c91e3a` — fix(grid): tick-based price matching + idempotent order inserts
- Reemplazó tolerancia `$1.0` por `tick_size` en 3 sitios (0x00 fix, fill matching REST, fill matching WS)
- `INSERT OR IGNORE` en `createOrder` para que duplicados no rompan el flujo
- Incluye mejoras previas: `roundToTick`/`roundToStep` en todos lados, verificación de leverage, guardia de liquidación

### 2. `839afe9` — fix(grid): GRVT price truncation — order_id matching + wider tolerance
- 0x00 fix: tolerancia 0.005 + disambiguación por closest-match + espera 2s
- Monitor: Strategy 1 (match por `order_id` exacto) + Strategy 2 (fallback por precio con tolerancia 0.005)
- Fill matching: tolerancia 0.005
- Mantiene tick_size=0.0001 para placement (correcto según GRVT API)

### 3. `9da72a9` — fix(grid): use list + closest-match for GRVT price bucket disambiguation
- Cambió `grvtPrices` de Map a lista plana para no perder órdenes duplicadas en un bucket
- Closest-match entre todas las órdenes GRVT no consumidas dentro del bucket

## Qué falla todavía

Los 3 commits resolvieron el UNIQUE constraint y el matching por order_id, pero **no resuelven la ambigüedad fundamental**: cuando ~5 niveles comparten un centavo y solo hay 1 orden GRVT visible, el closest-match cubre 1 nivel y los otros 4 quedan uncovered → el monitor los re-place → GRVT crea nuevas órdenes → más ambigüedad → ciclo inestable.

## 3 opciones de solución (decidir cuál implementar)

### Opción A: Grilla espaciada a $0.01 (~9 niveles)
- Cambiar `num_grids` de 50 a ~9, spacing=$0.01 (un nivel por centavo)
- Ventaja: simple, sin ambigüedad, matching por precio funciona perfecto
- Desventaja: muchos menos niveles → menos oportunidades de grid trading
- Implementación: solo cambiar parámetros del bot, sin cambios de código

### Opción B: Tracking por order_id real (mejor approach)
- Cuando el 0x00 fix resuelve un order_id, guardarlo en `grid_levels.order_id`
- El monitor hace Strategy 1 (order_id exacto) antes que Strategy 2 (precio)
- Para niveles con `0x00`/`temp_*`: NO re-place — marcar como "pending resolution"
- En el siguiente tick, el 0x00 fix ya habrá resuelto el ID → Strategy 1 matchea
- Ventaja: mantiene 50 niveles con tick 0.0001, resolución precisa
- Desventaja: requiere 2 ticks para estabilizar (1 para colocar, 1 para resolver ID)
- Implementación: cambios en monitor + 0x00 fix + posiblemente un "resolution pass"

### Opción C: Bucket como nivel (una orden real por centavo, múltiples niveles lógicos)
- Agrupar niveles de grilla por bucket de 2 decimales
- 1 orden GRVT cubre todos los niveles en ese bucket
- Cuando la orden se llena, el counter-order se coloca al precio del nivel más cercano al fill real
- Ventaja: maximiza densidad de niveles sin ambigüedad
- Desventaja: más complejo, cambia la semántica del grid (niveles lógicos vs físicos)
- Implementación: refactoring significativo del monitor y coverage check

## Estado actual

- Bot 4: **paused**, 0 órdenes en GRVT, 0 niveles/orders en DB
- Container: **stopped**
- Posición: **sin posición abierta**
- Código: 3 commits en `main`, compila limpio, Docker image buildiada con todos los fixes
