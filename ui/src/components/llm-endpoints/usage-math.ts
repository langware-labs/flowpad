/**
 * Arithmetic behind the usage panel: cohort → time range, series → totals /
 * chart points, limit → remaining ratio.
 *
 * Cohorts are the cost dashboard's `TIME_COHORTS` (today / week / month / all),
 * so the two screens agree on what "this week" means: calendar weeks start on
 * Monday, all in UTC — the hub's ledger windows are UTC days/weeks/months, so a
 * local-time cohort would straddle two ledger buckets.
 *
 * **Pure.** `now` is a parameter everywhere, so tests pin the clock.
 */
import type { LLMChainRemaining, LLMUsageCounters, LLMUsageGranularity, LLMUsagePoint } from '@sdk';
import type { TimeCohort } from '@src/components/cost-dashboard/constants';

export { TIME_COHORTS } from '@src/components/cost-dashboard/constants';

export interface UsageRange {
  /** Epoch seconds, inclusive. */
  from: number;
  /** Epoch seconds, exclusive. */
  to: number;
  granularity: LLMUsageGranularity;
}

/** The ledger began with the feature; "all time" needs a finite start. */
const ALL_TIME_DAYS = 365;

/** [from, to) for a cohort, in epoch seconds, UTC-aligned. */
export function cohortRange(cohort: TimeCohort, now: Date = new Date()): UsageRange {
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const to = Math.floor(now.getTime() / 1000) + 1;
  switch (cohort) {
    case 'today':
      return { from: Math.floor(dayStart / 1000), to, granularity: 'hour' };
    case 'thisWeek': {
      const daysSinceMonday = (now.getUTCDay() + 6) % 7;
      return { from: Math.floor(dayStart / 1000) - daysSinceMonday * 86400, to, granularity: 'day' };
    }
    case 'thisMonth': {
      const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
      return { from: Math.floor(monthStart / 1000), to, granularity: 'day' };
    }
    case 'allTime':
    default:
      return { from: Math.floor(dayStart / 1000) - ALL_TIME_DAYS * 86400, to, granularity: 'day' };
  }
}

export const ZERO_COUNTERS: LLMUsageCounters = {
  requests: 0,
  fallbacks: 0,
  errors: 0,
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  cost_usd: 0,
  latency_ms_sum: 0,
  ttfb_ms_sum: 0,
  estimated_requests: 0,
  unpriced_requests: 0,
  total_tokens: 0,
};

const COUNTER_KEYS = Object.keys(ZERO_COUNTERS) as (keyof LLMUsageCounters)[];

export function addCounters(a: LLMUsageCounters, b: Partial<LLMUsageCounters>): LLMUsageCounters {
  const out = { ...a };
  for (const k of COUNTER_KEYS) out[k] = (a[k] ?? 0) + (b[k] ?? 0);
  return out;
}

/** Sum a series into one totals row. What the hub's `totals` should equal —
 *  used when only a series is at hand (e.g. batched list rows). */
export function aggregateSeries(series: readonly Partial<LLMUsageCounters>[]): LLMUsageCounters {
  return series.reduce<LLMUsageCounters>((acc, p) => addCounters(acc, p), { ...ZERO_COUNTERS });
}

export interface ChartPoint {
  /** Epoch seconds. */
  t: number;
  /** Axis label. */
  label: string;
  cost_usd: number;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  requests: number;
  errors: number;
  fallbacks: number;
}

function labelFor(bucketStart: number, granularity: LLMUsageGranularity): string {
  const d = new Date(bucketStart * 1000);
  const two = (n: number) => String(n).padStart(2, '0');
  return granularity === 'hour' ? `${two(d.getUTCHours())}:00` : `${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}`;
}

/**
 * Series → one point per bucket, dims collapsed, sorted by time, with EMPTY
 * buckets filled across `range` so a quiet hour shows as zero rather than a
 * gap the line skips over.
 */
export function toChartPoints(
  series: readonly LLMUsagePoint[],
  range: UsageRange,
  granularity: LLMUsageGranularity = range.granularity,
): ChartPoint[] {
  const step = granularity === 'hour' ? 3600 : 86400;
  const byBucket = new Map<number, LLMUsageCounters>();
  for (const p of series) {
    const bucket = Math.floor(p.bucket_start / step) * step;
    byBucket.set(bucket, addCounters(byBucket.get(bucket) ?? ZERO_COUNTERS, p));
  }
  const first = Math.floor(range.from / step) * step;
  const last = Math.floor(Math.max(range.to - 1, range.from) / step) * step;
  const out: ChartPoint[] = [];
  for (let t = first; t <= last; t += step) {
    const c = byBucket.get(t) ?? ZERO_COUNTERS;
    out.push({
      t,
      label: labelFor(t, granularity),
      cost_usd: c.cost_usd,
      total_tokens: c.total_tokens,
      input_tokens: c.input_tokens,
      output_tokens: c.output_tokens,
      requests: c.requests,
      errors: c.errors,
      fallbacks: c.fallbacks,
    });
  }
  return out;
}

/** 0..1 share of a limit that is left; 1 when there is no limit. Clamped. */
export function remainingRatio(r: Pick<LLMChainRemaining, 'limit' | 'remaining'> | null | undefined): number {
  if (!r || !(r.limit > 0)) return 1;
  return Math.min(1, Math.max(0, r.remaining / r.limit));
}

/** Round to the cents/millicents the dashboard shows. */
export function formatUsd(value: number): string {
  if (!value) return '$0';
  // A single haiku call is ~$0.00003: show enough digits that a real spend never reads as $0.
  if (value < 0.0001) return `$${value.toPrecision(2)}`;
  if (value < 0.01) return `$${value.toFixed(5)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}
