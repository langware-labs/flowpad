import type { AgenticProcess } from '@sdk';
import type { TraceEvent } from '@src/types/trace-event';
import { useFlowDataTrace } from '@src/hooks/use-flow-data-trace';
import type { PtySyncSession } from '@sdk/pty-sync/PtySyncSession.js';
import { useMemo } from 'react';

export interface TraceGutterEntry {
  absRow: number | null;
  event: TraceEvent;
}

/**
 * Bridges the unified `AgenticProcess.flowDataStream` -> gutter entries.
 *
 * Replaces the old `useClaudeSessionTrace` (Claude-only) plus a
 * transcript-vs-sniffer anchor split. Now the source of truth is a single
 * stream of `FlowData` (history + live + sniffer, merged + de-duplicated by
 * `flowDataStream.ingest`); we bucket every entry uniformly by timestamp.
 *
 * No setState here — bucketing is a pure function of (event, ptySyncSession),
 * computed inline in the `entries` memo. The previous version kept an
 * `anchorMap` + `anchorVersion` setState cycle, which caused a render loop
 * when combined with the new FlowData-based event source.
 */
export function useTraceGutter(
  process: AgenticProcess | null,
  terminalReady: boolean,
  ptySyncSession: PtySyncSession,
  replayComplete: boolean,
  snapshotVersion: number,
): {
  entries: TraceGutterEntry[];
  totalTraceEvents: number;
  historicalCount: number;
  liveCount: number;
  sessionStartTime: string | null;
  allEvents: TraceEvent[];
} {
  const { events: allTraceEvents, historicalCount, liveCount, sessionStartTime } = useFlowDataTrace(process);

  const entries: TraceGutterEntry[] = useMemo(() => {
    if (!terminalReady || !process || !replayComplete) return [];
    const seen = new Set<string>();
    const out: TraceGutterEntry[] = [];
    for (const event of allTraceEvents) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      const ts = new Date(event.timestamp).getTime();
      const absRow = isNaN(ts) ? null : ptySyncSession.bucketTimestamp(ts);
      out.push({ absRow, event });
    }
    return out;
    // snapshotVersion is included so consumers re-render when segments
    // change (the underlying ptySyncSession.bucketTimestamp answers shift).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalReady, process?.id, replayComplete, snapshotVersion, allTraceEvents, ptySyncSession]);

  return { entries, totalTraceEvents: entries.length, historicalCount, liveCount, sessionStartTime, allEvents: allTraceEvents };
}
