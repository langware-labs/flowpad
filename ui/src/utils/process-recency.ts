import type { AgenticProcess } from '@sdk';

/** Epoch-ms from an epoch number or an ISO string, else 0. */
function toMs(value: number | string | null | undefined): number {
  if (typeof value === 'number') return value;
  const n = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isNaN(n) ? 0 : n;
}

/** Recency key for picking "the" process when more than one is linked —
 *  most-recently-active wins, falling back to created_at, then 0. */
export function recencyOf(p: AgenticProcess): number {
  return toMs(p.last_active_at) || toMs((p as { created_at?: string }).created_at);
}

/** Pick the most-recently-active process, or null for an empty list. */
export function mostRecentProcess(processes: readonly AgenticProcess[]): AgenticProcess | null {
  if (!processes.length) return null;
  return processes.reduce((a, b) => (recencyOf(b) > recencyOf(a) ? b : a));
}
