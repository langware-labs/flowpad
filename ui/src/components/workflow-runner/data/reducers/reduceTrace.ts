/**
 * Parse workflow.trace.jsonl → per-line trace summary.
 *
 * Aggregation:
 *   - enter + done                 → status=done, duration_ms = ts_done - ts_enter
 *   - multiple enter+done cycles   → status=retried (or error if any errored), attempts=N
 *   - error event                  → status=error
 *   - skip event                   → status=skip
 *   - enter with no terminal event → status=incomplete (only when explicitly marked)
 *
 * Cost is paired in a second pass when transcript usage is available — the
 * caller (useRunnerData) supplies the usage list; we sum entries whose ISO
 * timestamp falls inside [first_enter_ts, last_terminal_ts].
 */

import { pricingFor, type UsageEntry } from '@sdk/transcript-analyzer';

import type { AnalyzedStatus, WorkflowReportEntry } from '../../data/types';

export interface TraceSummary {
  /** 1-indexed line in the workflow .md file. */
  line: number;
  /** Terminal status. `incomplete` only when explicitly emitted. */
  status: AnalyzedStatus | 'retried';
  /** Total wall-clock ms across all enter→done attempts. */
  durationMs: number;
  /** Attempt count (>1 implies retried). */
  attempts: number;
  /** Optional detail string from the trace event. */
  detail?: string;
  errorMessage?: string;
  /** ISO timestamps bracketing this line's activity across attempts. */
  startedAt?: string;
  endedAt?: string;
  /** USD cost paired from transcript usage; undefined when usage missing. */
  costUsd?: number;
}

function parseLines(jsonl: string): WorkflowReportEntry[] {
  return jsonl
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as WorkflowReportEntry;
      } catch {
        return null;
      }
    })
    .filter(
      (e): e is WorkflowReportEntry =>
        !!e && e.kind === 'step' && typeof e.line === 'number',
    );
}

function costInWindow(
  usage: UsageEntry[],
  startTs?: string,
  endTs?: string,
): number {
  if (!startTs || !endTs || usage.length === 0) return 0;
  let total = 0;
  for (const e of usage) {
    if (!e.timestamp || e.timestamp < startTs || e.timestamp > endTs) continue;
    total += pricingFor(e.model).costOf(e);
  }
  return total;
}

export function reduceTrace(
  jsonl: string,
  usage: UsageEntry[] = [],
): TraceSummary[] {
  const events = parseLines(jsonl);
  type Acc = {
    line: number;
    attempts: number;
    totalMs: number;
    status: TraceSummary['status'];
    detail?: string;
    errorMessage?: string;
    startedAt?: string;
    endedAt?: string;
    pendingEnter?: string;
  };

  const byLine = new Map<number, Acc>();
  for (const ev of events) {
    let acc = byLine.get(ev.line);
    if (!acc) {
      acc = { line: ev.line, attempts: 0, totalMs: 0, status: 'done' };
      byLine.set(ev.line, acc);
    }
    if (ev.status === 'enter') {
      acc.pendingEnter = ev.ts;
      if (!acc.startedAt) acc.startedAt = ev.ts;
    } else if (ev.status === 'done' || ev.status === 'error') {
      if (acc.pendingEnter && ev.ts) {
        const enterMs = new Date(acc.pendingEnter).getTime();
        const exitMs = new Date(ev.ts).getTime();
        if (Number.isFinite(enterMs) && Number.isFinite(exitMs)) {
          acc.totalMs += Math.max(0, exitMs - enterMs);
        }
        acc.pendingEnter = undefined;
      }
      acc.attempts += 1;
      acc.endedAt = ev.ts;
      if (ev.detail) acc.detail = ev.detail;
      if (ev.status === 'error') {
        acc.status = 'error';
        if (ev.detail) acc.errorMessage = ev.detail;
      } else if (acc.status !== 'error') {
        acc.status = acc.attempts > 1 ? 'retried' : 'done';
      }
    } else if (ev.status === 'skip') {
      acc.status = 'skip';
      if (ev.detail) acc.detail = ev.detail;
      acc.endedAt = ev.ts;
    }
  }

  return Array.from(byLine.values())
    .map((a) => {
      const cost = costInWindow(usage, a.startedAt, a.endedAt);
      return {
        line: a.line,
        status: a.status,
        durationMs: a.totalMs,
        attempts: Math.max(1, a.attempts),
        detail: a.detail,
        errorMessage: a.errorMessage,
        startedAt: a.startedAt,
        endedAt: a.endedAt,
        costUsd: cost > 0 ? cost : undefined,
      } satisfies TraceSummary;
    })
    .sort((a, b) => a.line - b.line);
}
