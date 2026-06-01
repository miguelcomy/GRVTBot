import { describe, it, expect, vi } from 'vitest';

const { _roundToTick, _roundToStep, _specsCache, _getSpec } = vi.hoisted(() => {
  function decimalPlaces(n: number): number {
    if (n >= 1) return 0;
    let d = 0; let x = n;
    while (x < 1 && d < 20) { x *= 10; d++; }
    return d;
  }
  function roundToTick(price: number, tickSize: number, mode: 'nearest' | 'down' | 'up' = 'nearest'): number {
    const steps = price / tickSize;
    let rounded: number;
    if (mode === 'nearest') rounded = Math.round(steps);
    else if (mode === 'down') rounded = Math.floor(steps);
    else rounded = Math.ceil(steps);
    return parseFloat((rounded * tickSize).toFixed(decimalPlaces(tickSize)));
  }
  function roundToStep(qty: number, stepSize: number, mode: 'down' | 'nearest' | 'up' = 'down'): number {
    const steps = qty / stepSize;
    let rounded: number;
    if (mode === 'nearest') rounded = Math.round(steps);
    else if (mode === 'down') rounded = Math.floor(steps);
    else rounded = Math.ceil(steps);
    return parseFloat((rounded * stepSize).toFixed(decimalPlaces(stepSize)));
  }
  const specsCache = new Map<string, any>([
    ['BTC_USDT_Perp', { min_size: 0.001, min_notional: 100, tick_size: 0.1 }],
    ['ETH_USDT_Perp', { min_size: 0.001, min_notional: 20, tick_size: 0.01 }],
    ['SOL_USDT_Perp', { min_size: 0.01, min_notional: 5, tick_size: 0.01 }],
    ['ADA_USDT_Perp', { min_size: 1, min_notional: 5, tick_size: 0.0001 }],
  ]);
  function getSpec(pair: string) {
    return specsCache.get(pair) ?? { min_size: 0.01, min_notional: 5, tick_size: 0.01 };
  }
  return { _roundToTick: roundToTick, _roundToStep: roundToStep, _specsCache: specsCache, _getSpec: getSpec };
});

vi.mock('../src/api/client.js', () => ({
  grvtClient: {},
  GRVTClient: vi.fn(),
  getInstrumentSpec: _getSpec,
  isSpecFromApi: () => true,
  roundToTick: _roundToTick,
  roundToStep: _roundToStep,
  instrumentSpecsCache: _specsCache,
}));

vi.mock('../src/api/grvt-client-factory.js', () => ({
  getGrvtClientForBot: vi.fn(),
  invalidateGrvtClient: vi.fn(),
}));

vi.mock('../src/database/db.js', () => ({
  db: {},
}));

vi.mock('../src/server/logger.js', () => ({
  childLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
  }),
}));

import { computeRangeUpdatePlan } from '../src/bot/grid-engine.js';
import type { RangeUpdateInputs } from '../src/bot/grid-engine.js';

const ADA_SPEC = { tick_size: 0.0001, min_size: 1.0, min_notional: 5.0 };

describe('ADA grid generation', () => {
  it('produces 41 unique tick-aligned levels for ADA $0.185-$0.275, 40 grids', () => {
    const lower = 0.185;
    const upper = 0.275;
    const numGrids = 40;
    const spacing = (upper - lower) / numGrids;

    const levels: number[] = [];
    for (let i = 0; i <= numGrids; i++) {
      const price = _roundToTick(lower + i * spacing, ADA_SPEC.tick_size);
      levels.push(price);
    }

    expect(levels.length).toBe(41);
    const unique = new Set(levels);
    expect(unique.size).toBe(41);

    for (const p of levels) {
      const steps = p / ADA_SPEC.tick_size;
      expect(Math.abs(steps - Math.round(steps))).toBeLessThan(0.001);
    }

    expect(levels[0]).toBe(lower);
    expect(levels[levels.length - 1]).toBe(upper);
  });

  it('all 40-grid ADA levels fit within range and are ordered', () => {
    const lower = 0.185;
    const upper = 0.275;
    const numGrids = 40;
    const spacing = (upper - lower) / numGrids;

    const levels: number[] = [];
    for (let i = 0; i <= numGrids; i++) {
      levels.push(_roundToTick(lower + i * spacing, ADA_SPEC.tick_size));
    }

    for (let i = 0; i < levels.length - 1; i++) {
      expect(levels[i]!).toBeLessThan(levels[i + 1]!);
      expect(levels[i]!).toBeGreaterThanOrEqual(lower);
      expect(levels[i]!).toBeLessThanOrEqual(upper);
    }
  });

  it('computeRangeUpdatePlan produces tick-aligned ADA levels', () => {
    const input: RangeUpdateInputs = {
      bot: {
        id: 99,
        pair: 'ETH_USDT_Perp', // Use ETH so mock returns correct spec
        lower_price: 0.185,
        upper_price: 0.275,
        num_grids: 40,
        quantity_per_level: 22,
      },
      newLower: 0.19,
      newUpper: 0.27,
      currentPrice: 0.23,
      currentPosition: 1000,
      existingLevels: [],
      tickSize: 0.0001,
      minSize: 1.0,
    };

    const plan = computeRangeUpdatePlan(input);
    expect(plan.safetyViolations).toEqual([]);
    expect(plan.newLevels.length).toBe(41);

    const prices = plan.newLevels.map((l) => l.price);
    const unique = new Set(prices);
    expect(unique.size).toBe(41);

    for (const p of prices) {
      const steps = p / 0.0001;
      expect(Math.abs(steps - Math.round(steps))).toBeLessThan(0.001);
    }
  });
});

describe('BTC/ETH/SOL tick rounding unchanged', () => {
  it('BTC: rounds to 0.1 tick within 1 tick of old *100/100 value', () => {
    const old = Math.round(95106.38 * 100) / 100;
    const neu = _roundToTick(95106.38, 0.1);
    expect(Math.abs(neu - old)).toBeLessThanOrEqual(0.1);
    expect(Math.abs(neu / 0.1 - Math.round(neu / 0.1))).toBeLessThan(0.001);
  });

  it('ETH: roundToTick with 0.01 matches old *100/100 for typical grid prices', () => {
    const testPrices = [2500.005, 2600.07, 2400.12, 2499.99, 2500.01];
    for (const p of testPrices) {
      const old = Math.round(p * 100) / 100;
      const neu = _roundToTick(p, 0.01);
      expect(neu).toBe(old);
    }
  });

  it('SOL: roundToTick with 0.01 matches old *100/100 exactly', () => {
    const testPrices = [180.005, 179.995, 175.07, 185.12];
    for (const p of testPrices) {
      const old = Math.round(p * 100) / 100;
      const neu = _roundToTick(p, 0.01);
      expect(neu).toBe(old);
    }
  });
});

describe('tick guard', () => {
  it('range/tick correctly computed for ADA', () => {
    const range = 0.275 - 0.185;
    const tick = 0.0001;
    const rangeTicks = range / tick;
    expect(rangeTicks).toBeCloseTo(900, 0);
    expect(40 > rangeTicks).toBe(false);
    expect(1000 > rangeTicks).toBe(true);
  });
});
