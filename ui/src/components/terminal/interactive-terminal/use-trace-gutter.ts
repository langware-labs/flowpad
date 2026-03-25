import type { ClaudeTraceEvent } from '@src/types/trace-event';
import { useClaudeSessionTrace } from '@src/hooks/use-claude-session-trace';
import type { PtySyncSession } from '@sdk/pty-sync/PtySyncSession.js';
import { useEffect, useMemo, useRef, useState } from 'react';

export interface TraceGutterEntry {
  absRow: number | null;
  event: ClaudeTraceEvent;
}

/**
 * Bridges sniffer events + historical transcript entries -> gutter entries.
 *
 * Sniffer events are bucketed immediately as they arrive.
 * Transcript events are bucketed after replayComplete, and re-bucketed
 * whenever snapshotVersion changes (i.e. segments were rebuilt from anchors).
 */
export function useTraceGutter(
  workerSessionId: string | undefined | null,
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
  allEvents: ClaudeTraceEvent[];
} {
  const { events: allTraceEvents, historicalCount, liveCount, sessionStartTime } = useClaudeSessionTrace(workerSessionId ?? null);

  const anchorMapRef = useRef<Map<string, number>>(new Map());
  const lastSnapshotVersionRef = useRef(-1);
  const [anchorVersion, setAnchorVersion] = useState(0);

  // Sniffer events are computed fresh on every render (not cached) so their
  // position always reflects the current segment endTime — never stale.

  // Bucket transcript events after replay completes, re-bucket when segments change
  const transcriptEvents = useMemo(
    () => allTraceEvents.filter((e) => e.source === 'transcript'),
    [allTraceEvents],
  );

  useEffect(() => {
    if (!terminalReady || !workerSessionId || !replayComplete) return;

    const segmentsChanged = snapshotVersion !== lastSnapshotVersionRef.current;
    lastSnapshotVersionRef.current = snapshotVersion;

    // When segments are rebuilt, clear transcript buckets so they re-resolve
    if (segmentsChanged) {
      for (const event of transcriptEvents) {
        anchorMapRef.current.delete(event.id);
      }
    }

    let added = false;
    for (const event of transcriptEvents) {
      if (anchorMapRef.current.has(event.id)) continue;
      const ts = new Date(event.timestamp).getTime();
      if (isNaN(ts)) continue;
      anchorMapRef.current.set(event.id, ptySyncSession.bucketTimestamp(ts));
      added = true;
    }
    if (added || segmentsChanged) setAnchorVersion((v) => v + 1);
  }, [terminalReady, workerSessionId, replayComplete, snapshotVersion, transcriptEvents, ptySyncSession]);

  // Clean up when session changes
  useEffect(() => {
    const anchorMap = anchorMapRef.current;
    return () => {
      anchorMap.clear();
      lastSnapshotVersionRef.current = -1;
    };
  }, [workerSessionId]);

  // Build gutter entries with absRow
  const entries: TraceGutterEntry[] = useMemo(() => {
    const seen = new Set<string>();
    return allTraceEvents
      .filter((e) => {
        if (seen.has(e.id)) return false;
        seen.add(e.id);
        return true;
      })
      .map((e) => {
        let absRow: number | null;
        if (e.source === 'sniffer') {
          // Compute fresh each render so position reflects current segment endTime
          const ts = new Date(e.timestamp).getTime();
          absRow = isNaN(ts) ? null : ptySyncSession.bucketTimestamp(ts);
        } else {
          absRow = anchorMapRef.current.get(e.id) ?? null;
        }
        return { absRow, event: e };
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allTraceEvents, anchorVersion, ptySyncSession]);

  return { entries, totalTraceEvents: entries.length, historicalCount, liveCount, sessionStartTime, allEvents: allTraceEvents };
}
