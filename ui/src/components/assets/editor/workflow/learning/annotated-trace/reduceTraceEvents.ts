import type { AnchoredItem } from '@src/components/anchored-markdown';
import type { TraceMark } from '@src/components/anchored-markdown';

interface TraceEvent {
  kind: string;
  file?: string;
  line?: number;
  status?: 'enter' | 'done' | 'skip' | 'error';
  message?: string;
  ts?: string;
}

/**
 * Parse newline-delimited JSON trace events into anchored marks per source line.
 *
 * Aggregation rules (from the plan):
 *   - enter+done pair → ● done with total duration
 *   - multiple enter+done cycles for the same line → ⊙ retried
 *     with attempt count and total time across attempts
 *   - error event → ✗ error with message in tooltip
 *   - skip event → − skip
 */
export function reduceTraceEvents(jsonl: string): AnchoredItem<TraceMark>[] {
  const events = jsonl
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l) as TraceEvent;
      } catch {
        return null;
      }
    })
    .filter((e): e is TraceEvent => !!e && e.kind === 'step' && typeof e.line === 'number');

  type Acc = {
    line: number;
    attempts: number;
    totalMs: number;
    status: TraceMark['status'];
    errorMessage?: string;
    startedAt?: string;
    endedAt?: string;
    pendingEnter?: string;
  };

  const byLine = new Map<number, Acc>();
  for (const ev of events) {
    if (ev.line == null) continue;
    let acc = byLine.get(ev.line);
    if (!acc) {
      acc = {
        line: ev.line,
        attempts: 0,
        totalMs: 0,
        status: 'done',
      };
      byLine.set(ev.line, acc);
    }
    if (ev.status === 'enter') {
      acc.pendingEnter = ev.ts;
      if (!acc.startedAt) acc.startedAt = ev.ts;
    } else if (ev.status === 'done' || ev.status === 'error') {
      if (acc.pendingEnter && ev.ts) {
        acc.totalMs += Math.max(0, new Date(ev.ts).getTime() - new Date(acc.pendingEnter).getTime());
        acc.pendingEnter = undefined;
      }
      acc.attempts += 1;
      acc.endedAt = ev.ts;
      if (ev.status === 'error') {
        acc.status = 'error';
        if (ev.message) acc.errorMessage = ev.message;
      } else if (acc.status !== 'error') {
        acc.status = acc.attempts > 1 ? 'retried' : 'done';
      }
    } else if (ev.status === 'skip') {
      acc.status = 'skip';
    }
  }

  return Array.from(byLine.values()).map((a) => ({
    id: `trace:${a.line}`,
    anchor: { line: a.line },
    data: {
      status: a.status,
      durationMs: a.totalMs,
      attempts: Math.max(1, a.attempts),
      errorMessage: a.errorMessage,
      startedAt: a.startedAt,
      endedAt: a.endedAt,
    } satisfies TraceMark,
  }));
}
