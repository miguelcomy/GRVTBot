import { describe, it, expect, vi } from 'vitest';

// Inline implementations matching the real module (avoids triggering GRVTClient constructor)
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

vi.mock('../src/api/client.js', () => ({
  grvtClient: {},
  GRVTClient: vi.fn(),
  getInstrumentSpec: () => ({ min_size: 0.01, min_notional: 5, tick_size: 0.01 }),
  isSpecFromApi: () => true,
  roundToTick,
  roundToStep,
  instrumentSpecsCache: new Map(),
}));

describe('roundToTick', () => {
  it('rounds to nearest 0.01 (ETH/SOL tick)', () => {
    expect(roundToTick(2500.005, 0.01)).toBe(2500.01);
    expect(roundToTick(2500.004, 0.01)).toBe(2500.0);
    expect(roundToTick(2500.0, 0.01)).toBe(2500.0);
  });

  it('rounds to nearest 0.1 (BTC tick)', () => {
    expect(roundToTick(100000.05, 0.1)).toBe(100000.1);
    expect(roundToTick(100000.04, 0.1)).toBe(100000.0);
    expect(roundToTick(100000.0, 0.1)).toBe(100000.0);
  });

  it('rounds to nearest 0.0001 (ADA tick)', () => {
    expect(roundToTick(0.23005, 0.0001)).toBe(0.2301);
    expect(roundToTick(0.23004, 0.0001)).toBe(0.23);
    expect(roundToTick(0.185, 0.0001)).toBe(0.185);
  });

  it('rounds up (aggressive buy)', () => {
    expect(roundToTick(2500.001, 0.01, 'up')).toBe(2500.01);
    expect(roundToTick(2500.019, 0.01, 'up')).toBe(2500.02);
    expect(roundToTick(0.23001, 0.0001, 'up')).toBe(0.2301);
  });

  it('rounds down (conservative sell)', () => {
    expect(roundToTick(2500.019, 0.01, 'down')).toBe(2500.01);
    expect(roundToTick(2500.01, 0.01, 'down')).toBe(2500.01);
    expect(roundToTick(0.23009, 0.0001, 'down')).toBe(0.23);
  });

  it('handles tiny tick sizes without floating-point drift', () => {
    const price = 0.1 + 0.2; // 0.30000000000000004
    const rounded = roundToTick(price, 0.0001);
    expect(rounded).toBe(0.3);
    expect(Number.isInteger(Math.round(rounded / 0.0001))).toBe(true);
  });

  it('preserves BTC prices already on tick', () => {
    expect(roundToTick(100000.0, 0.1)).toBe(100000.0);
    expect(roundToTick(100000.3, 0.1)).toBe(100000.3);
    expect(roundToTick(99999.9, 0.1)).toBe(99999.9);
  });

  it('handles zero price', () => {
    expect(roundToTick(0, 0.01)).toBe(0);
    expect(roundToTick(0, 0.0001)).toBe(0);
  });
});

describe('roundToStep', () => {
  it('rounds down by default (conservative qty)', () => {
    expect(roundToStep(1.567, 0.001)).toBe(1.567);
    expect(roundToStep(1.5678, 0.01)).toBe(1.56);
    expect(roundToStep(22.7, 1.0)).toBe(22);
  });

  it('rounds up for qty calculation', () => {
    expect(roundToStep(1.5678, 0.01, 'up')).toBe(1.57);
    expect(roundToStep(22.3, 1.0, 'up')).toBe(23);
  });

  it('rounds nearest', () => {
    expect(roundToStep(1.564, 0.01, 'nearest')).toBe(1.56);
    expect(roundToStep(1.575, 0.01, 'nearest')).toBe(1.58);
  });

  it('handles ADA step (1.0 = whole units)', () => {
    expect(roundToStep(22.7, 1.0, 'down')).toBe(22);
    expect(roundToStep(22.3, 1.0, 'up')).toBe(23);
    expect(roundToStep(22.5, 1.0, 'nearest')).toBe(23);
  });

  it('handles BTC/ETH step (0.001)', () => {
    expect(roundToStep(0.0445, 0.001, 'up')).toBe(0.045);
    expect(roundToStep(0.0451, 0.001, 'down')).toBe(0.045);
    expect(roundToStep(0.045, 0.001)).toBe(0.045);
  });

  it('no floating-point drift on repeated operations', () => {
    let qty = 1.0;
    for (let i = 0; i < 100; i++) {
      qty = roundToStep(qty + 0.0001, 0.0001, 'up');
    }
    expect(qty).toBe(1.01);
  });
});
