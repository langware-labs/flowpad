/**
 * Cohort ranges (UTC-aligned, Monday weeks), chart points with gap-filling,
 * remaining ratios.
 */
import type { LLMUsagePoint } from '@sdk';
import { describe, expect, it } from 'vitest';

import {
  childLabel,
  cohortRange,
  formatAmount,
  formatUsd,
  ratioTone,
  remainingRatio,
  toChartPoints,
  usedRatio,
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

  it('`to` is floored to the minute so two callers within a minute share a key', () => {
    const later = new Date(NOW.getTime() + 42_000);
    expect(cohortRange('today', later).to).toBe(cohortRange('today', NOW).to);
    expect(cohortRange('today', new Date(NOW.getTime() + 60_000)).to).toBe(cohortRange('today', NOW).to + 60);
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

describe('usedRatio / ratioTone', () => {
  it('usedRatio is the mirror of remainingRatio; no limit reads as empty', () => {
    expect(usedRatio({ limit: 10, remaining: 2.5 })).toBe(0.75);
    expect(usedRatio({ limit: 10, remaining: -3 })).toBe(1);
    expect(usedRatio({ limit: 0, remaining: 0 })).toBe(0);
    expect(usedRatio(null)).toBe(0);
  });

  it('the tone shifts at 70 % and 90 % used', () => {
    expect(ratioTone(0)).toBe('ok');
    expect(ratioTone(0.69)).toBe('ok');
    expect(ratioTone(0.7)).toBe('amber');
    expect(ratioTone(0.89)).toBe('amber');
    expect(ratioTone(0.9)).toBe('destructive');
    expect(ratioTone(1)).toBe('destructive');
  });

  it('the same limit reads the same on a bar and on a headline', () => {
    const spent = { limit: 10, remaining: 0.5 };
    expect(ratioTone(usedRatio(spent))).toBe('destructive');
  });
});

describe('formatAmount', () => {
  it("formats in the key's own unit", () => {
    expect(formatAmount('cost_usd_per_day', 3.2)).toBe('$3.20');
    expect(formatAmount('tokens_per_month', 42_000)).toBe('42.0K');
    expect(formatAmount('requests_per_minute', 60)).toBe('60');
  });
});

describe('childLabel', () => {
  const CHILD = 'abcdef00-0000-4000-8000-000000000000';

  it("prefers the hub's names map, then a local lookup, then the raw dim", () => {
    const dim = `llm_endpoint-${CHILD}`;
    expect(childLabel(dim, { [dim]: 'Dana' }, () => 'stale')).toBe('Dana');
    expect(childLabel(dim, {}, (id) => (id === CHILD ? 'Dana' : undefined))).toBe('Dana');
    expect(childLabel(dim)).toBe(dim);
  });
});
