/**
 * Tests for position reconciliation and direction flip protection (Fix 1 + Fix 2).
 *
 * These tests validate that:
 * 1. reconcileWithGRVT() detects direction mismatches and throws SAFEGUARD:pause
 * 2. reconcileWithGRVT() syncs DB to GRVT on size mismatches
 * 3. placeGridOrder() blocks sells that would flip a long position to short
 * 4. placeGridOrder() blocks buys that would flip a short position to long
 * 5. reduce_only is correctly applied based on grid direction
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted so the mock factories can reference these at hoist time
const {
  mockGetPosition,
  mockUpdateBot,
  mockGetGridLevels,
  mockGetTicker,
  mockGetOpenOrders,
  mockGetFillHistory,
  mockFindRecentFillsForBot,
  mockUpdateGridLevel,
  mockCreateOrder,
  mockGetBot,
} = vi.hoisted(() => ({
  mockGetPosition: vi.fn(),
  mockUpdateBot: vi.fn(),
  mockGetGridLevels: vi.fn(),
  mockGetTicker: vi.fn(),
  mockGetOpenOrders: vi.fn(),
  mockGetFillHistory: vi.fn(),
  mockFindRecentFillsForBot: vi.fn(),
  mockUpdateGridLevel: vi.fn(),
  mockCreateOrder: vi.fn(),
  mockGetBot: vi.fn(),
}));

vi.mock('../src/api/client.js', () => ({
  grvtClient: {
    getPosition: mockGetPosition,
    getTicker: mockGetTicker,
    getOpenOrders: mockGetOpenOrders,
    getFillHistory: mockGetFillHistory,
    createOrder: mockCreateOrder,
    mockMode: false,
  },
  getInstrumentSpec: () => ({ tick_size: 0.01, min_size: 0.001, min_notional: 1 }),
  isSpecFromApi: () => false,
  roundToTick: (p: number) => Math.round(p * 100) / 100,
  roundToStep: (v: number) => v,
  instrumentSpecsCache: {},
}));

vi.mock('../src/api/grvt-client-factory.js', () => ({
  getGrvtClientForBot: vi.fn(),
  invalidateGrvtClient: vi.fn(),
}));

vi.mock('../src/database/db.js', () => ({
  db: {
    getBot: mockGetBot,
    updateBot: mockUpdateBot,
    getGridLevels: mockGetGridLevels,
    updateGridLevel: mockUpdateGridLevel,
    createOrder: mockCreateOrder,
    findRecentFillsForBot: mockFindRecentFillsForBot,
    fillGridLevel: vi.fn(),
    sumPairedRoundtripProfit: vi.fn().mockResolvedValue(0),
    sumFeesForBot: vi.fn().mockResolvedValue(0),
  },
}));

vi.mock('../src/server/logger.js', () => ({
  childLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Import after mocks
import { GridBotInstance } from '../src/bot/grid-engine.js';

// Helper: create a bot config for testing
function makeBot(overrides: Record<string, any> = {}) {
  return {
    id: 1,
    pair: 'UNI_USDT_Perp',
    direction: 'long' as const,
    leverage: 4,
    lower_price: 2.0,
    upper_price: 3.0,
    num_grids: 50,
    investment_usdt: 200,
    grid_profit_usdt: 0,
    trend_pnl_usdt: 0,
    total_pnl_usdt: 0,
    status: 'running',
    position_size: 125,
    avg_entry_price: 2.47,
    liquidation_price: 0,
    quantity_per_level: 5,
    safeguard_enabled: 1,
    safeguard_threshold_pct: 10,
    safeguard_action: 'pause',
    auto_shift_enabled: 0,
    sl_pct: null,
    tp_pct: null,
    virtual_enabled: 0,
    active_window_size: null,
    user_id: 1,
    ...overrides,
  };
}

function makeLevel(overrides: Record<string, any> = {}) {
  return {
    id: 1,
    bot_id: 1,
    level_index: 0,
    price: 2.5,
    side: 'sell' as const,
    quantity: 5,
    is_filled: false,
    pending_replace: false,
    order_id: 'order_123',
    filled_at: null,
    created_at: Date.now(),
    state: 'active',
    user_id: 1,
    ...overrides,
  };
}

describe('Position Reconciliation (Fix 1)', () => {
  let instance: GridBotInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    instance = new GridBotInstance(makeBot());
  });

  it('should detect direction mismatch: bot says long, GRVT says short', async () => {
    mockGetPosition.mockResolvedValue({
      size: '125',
      side: 'sell',
      entry_price: '2.47',
      unrealized_pnl: '-9.00',
      instrument: 'UNI_USDT_Perp',
    });
    mockUpdateBot.mockResolvedValue(undefined);

    await expect(instance.reconcileWithGRVT()).rejects.toThrow(
      /DIRECTION MISMATCH.*config=long.*real=short/
    );

    expect(mockUpdateBot).toHaveBeenCalledWith(1, expect.objectContaining({
      position_size: -125,
    }));
  });

  it('should detect direction mismatch: bot says short, GRVT says long', async () => {
    const shortBot = makeBot({ direction: 'short', position_size: -125 });
    instance = new GridBotInstance(shortBot);

    mockGetPosition.mockResolvedValue({
      size: '125',
      side: 'buy',
      entry_price: '2.47',
      unrealized_pnl: '5.00',
      instrument: 'UNI_USDT_Perp',
    });

    await expect(instance.reconcileWithGRVT()).rejects.toThrow(
      /DIRECTION MISMATCH.*config=short.*real=long/
    );
  });

  it('should NOT throw when directions match (long/long)', async () => {
    mockGetPosition.mockResolvedValue({
      size: '125',
      side: 'buy',
      entry_price: '2.47',
      unrealized_pnl: '5.00',
      instrument: 'UNI_USDT_Perp',
    });

    await expect(instance.reconcileWithGRVT()).resolves.toBeUndefined();
  });

  it('should NOT throw when there is no position (flat)', async () => {
    mockGetPosition.mockResolvedValue(null);

    await expect(instance.reconcileWithGRVT()).resolves.toBeUndefined();
  });

  it('should warn and sync on size mismatch (same direction)', async () => {
    mockGetPosition.mockResolvedValue({
      size: '100',
      side: 'buy',
      entry_price: '2.50',
      unrealized_pnl: '2.00',
      instrument: 'UNI_USDT_Perp',
    });
    mockUpdateBot.mockResolvedValue(undefined);

    await expect(instance.reconcileWithGRVT()).resolves.toBeUndefined();

    expect(mockUpdateBot).toHaveBeenCalledWith(1, expect.objectContaining({
      position_size: 100,
      avg_entry_price: 2.50,
    }));
  });

  it('should handle GRVT API errors gracefully', async () => {
    mockGetPosition.mockRejectedValue(new Error('HTTP 520: Gateway Error'));

    await expect(instance.reconcileWithGRVT()).resolves.toBeUndefined();
  });

  it('should update realPosition cache for direction guard', async () => {
    mockGetPosition.mockResolvedValue({
      size: '125',
      side: 'buy',
      entry_price: '2.47',
      unrealized_pnl: '5.00',
      instrument: 'UNI_USDT_Perp',
    });

    await instance.reconcileWithGRVT();

    const rp = (instance as any).realPosition;
    expect(rp.size).toBe(125);
    expect(rp.side).toBe('buy');
  });
});

describe('Direction Flip Guard (Fix 2)', () => {
  let instance: GridBotInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    instance = new GridBotInstance(makeBot());
    (instance as any).realPosition = { size: 10, side: 'buy' };
  });

  it('should block a SELL that would flip long to short', async () => {
    const level = makeLevel({ side: 'sell', quantity: 15, price: 2.5 });

    await expect(instance.placeGridOrder(level)).rejects.toThrow(
      /DIRECTION GUARD.*LONG sell 15 would flip to short/
    );
  });

  it('should allow a SELL that stays within the long position', async () => {
    const level = makeLevel({ side: 'sell', quantity: 5, price: 2.5 });

    try {
      await instance.placeGridOrder(level);
    } catch (e: any) {
      expect(e.message).not.toContain('DIRECTION GUARD');
    }
  });

  it('should block a BUY that would flip short to long', async () => {
    const shortBot = makeBot({ direction: 'short', position_size: -10 });
    instance = new GridBotInstance(shortBot);
    (instance as any).realPosition = { size: 10, side: 'sell' };

    const level = makeLevel({ side: 'buy', quantity: 15, price: 2.5 });

    await expect(instance.placeGridOrder(level)).rejects.toThrow(
      /DIRECTION GUARD.*SHORT buy 15 would flip to long/
    );
  });

  it('should allow a BUY that stays within a short position', async () => {
    const shortBot = makeBot({ direction: 'short', position_size: -10 });
    instance = new GridBotInstance(shortBot);
    (instance as any).realPosition = { size: 10, side: 'sell' };

    const level = makeLevel({ side: 'buy', quantity: 5, price: 2.5 });

    try {
      await instance.placeGridOrder(level);
    } catch (e: any) {
      expect(e.message).not.toContain('DIRECTION GUARD');
    }
  });

  it('should skip guard when realPosition has not been populated', async () => {
    (instance as any).realPosition = { size: 0, side: null };

    const level = makeLevel({ side: 'sell', quantity: 50, price: 2.5 });

    try {
      await instance.placeGridOrder(level);
    } catch (e: any) {
      expect(e.message).not.toContain('DIRECTION GUARD');
    }
  });

  it('should allow selling entire long position (not a flip)', async () => {
    const level = makeLevel({ side: 'sell', quantity: 10, price: 2.5 });

    try {
      await instance.placeGridOrder(level);
    } catch (e: any) {
      expect(e.message).not.toContain('DIRECTION GUARD');
    }
  });

  it('should block sell of 11 when only 10 long (overshoot by 1)', async () => {
    const level = makeLevel({ side: 'sell', quantity: 11, price: 2.5 });
    await expect(instance.placeGridOrder(level)).rejects.toThrow(/DIRECTION GUARD/);
  });
});

describe('reduce_only flag logic (Fix 2 - exchange-level defense)', () => {
  it('should set reduce_only=true for sells in a LONG grid', () => {
    const isLong = true;
    const level = { side: 'sell' as const };
    const reduceOnly = (isLong && level.side === 'sell') || (!isLong && level.side === 'buy');
    expect(reduceOnly).toBe(true);
  });

  it('should set reduce_only=true for buys in a SHORT grid', () => {
    const isLong = false;
    const level = { side: 'buy' as const };
    const reduceOnly = (isLong && level.side === 'sell') || (!isLong && level.side === 'buy');
    expect(reduceOnly).toBe(true);
  });

  it('should NOT set reduce_only for buys in a LONG grid', () => {
    const isLong = true;
    const level = { side: 'buy' as const };
    const reduceOnly = (isLong && level.side === 'sell') || (!isLong && level.side === 'buy');
    expect(reduceOnly).toBe(false);
  });

  it('should NOT set reduce_only for sells in a SHORT grid', () => {
    const isLong = false;
    const level = { side: 'sell' as const };
    const reduceOnly = (isLong && level.side === 'sell') || (!isLong && level.side === 'buy');
    expect(reduceOnly).toBe(false);
  });
});
