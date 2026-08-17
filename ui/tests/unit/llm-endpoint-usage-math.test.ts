/**
 * Cohort ranges (UTC-aligned, Monday weeks), series aggregation, chart points
 * with gap-filling, remaining ratios.
 */
import type { LLMUsagePoint } from '@sdk';
import { describe, expect, it } from 'vitest';

import {
  aggregateSeries,
  cohortRange,
  formatUsd,
  remainingRatio,
  toChartPoints,
  ZERO_COUNTERS,
} from '@src/components/llm-endpoints/usage-math';

// Wednesday 2026-08-19 13:37:00Z
const NOW = new Date(Date.UTC(2026, 7, 19, 13, 37, 0));
const sec = (d: Date) => Math.floor(d.getTime() / 1000);

const point = (bucket_start: number, over: Partial<LLMUsagePoint> = {}): LLMUsagePoint => ({
  ...ZERO_COUNTERS,
  bucket_start,
  dim: '',
  ...over,
});

describe('cohortRange', () => {
  it('today: UTC midnight → now, hourly', () => {
    const r = cohortRange('today', NOW);
    expect(r.from).toBe(sec(new Date(Date.UTC(2026, 7, 19))));
    expect(r.to).toBe(sec(NOW) + 1);
    expect(r.granularity).toBe('hour');
  });

  it('thisWeek: starts Monday 00:00Z, daily', () => {
    const r = cohortRange('thisWeek', NOW);
    expect(new Date(r.from * 1000).toISOString()).toBe('2026-08-17T00:00:00.000Z');
    expect(r.granularity).toBe('day');
  });

  it('thisWeek on a Monday starts today', () => {
    const monday = new Date(Date.UTC(2026, 7, 17, 5));
    expect(new Date(cohortRange('thisWeek', monday).from * 1000).toISOString()).toBe('2026-08-17T00:00:00.000Z');
  });

  it('thisMonth: the 1st 00:00Z, daily', () => {
    expect(new Date(cohortRange('thisMonth', NOW).from * 1000).toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });

  it('allTime is finite and daily', () => {
    const r = cohortRange('allTime', NOW);
    expect(r.from).toBeLessThan(cohortRange('thisMonth', NOW).from);
    expect(r.granularity).toBe('day');
  });
});

describe('aggregateSeries', () => {
  it('sums every counter', () => {
    const t = aggregateSeries([
      point(0, { requests: 2, cost_usd: 0.5, total_tokens: 100 }),
      point(3600, { requests: 1, cost_usd: 0.25, total_tokens: 50, errors: 1 }),
    ]);
    expect(t).toMatchObject({ requests: 3, cost_usd: 0.75, total_tokens: 150, errors: 1, fallbacks: 0 });
  });

  it('empty → zeros', () => {
    expect(aggregateSeries([])).toEqual(ZERO_COUNTERS);
  });
});

describe('toChartPoints', () => {
  it('fills every hour of the range and collapses dims into one bucket', () => {
    const range = cohortRange('today', NOW);
    const h10 = range.from + 10 * 3600;
    const points = toChartPoints(
      [point(h10, { dim: 'a', requests: 1, cost_usd: 0.1 }), point(h10, { dim: 'b', requests: 2, cost_usd: 0.2 })],
      range,
    );
    // 00:00 … 13:00 inclusive = 14 buckets
    expect(points).toHaveLength(14);
    expect(points[10]).toMatchObject({ label: '10:00', requests: 3 });
    expect(points[10].cost_usd).toBeCloseTo(0.3);
    expect(points[0]).toMatchObject({ label: '00:00', requests: 0 });
  });

  it('daily granularity labels MM-DD', () => {
    const range = cohortRange('thisWeek', NOW);
    const points = toChartPoints([], range);
    expect(points.map((p) => p.label)).toEqual(['08-17', '08-18', '08-19']);
  });
});

describe('remainingRatio', () => {
  it('is 1 with no limit, clamped 0..1 otherwise', () => {
    expect(remainingRatio(null)).toBe(1);
    expect(remainingRatio({ limit: 0, remaining: 0 })).toBe(1);
    expect(remainingRatio({ limit: 10, remaining: 2.5 })).toBe(0.25);
    expect(remainingRatio({ limit: 10, remaining: -3 })).toBe(0);
    expect(remainingRatio({ limit: 10, remaining: 30 })).toBe(1);
  });
});

describe('formatUsd', () => {
  it('shows more precision the smaller the amount', () => {
    expect(formatUsd(0)).toBe('$0');
    expect(formatUsd(0.0042)).toBe('$0.00420');
    expect(formatUsd(0.00003)).toBe('$0.000030');
    expect(formatUsd(0.42)).toBe('$0.420');
    expect(formatUsd(12.345)).toBe('$12.35');
  });
});
