/**
 * useFlowDataTrace
 *
 * Vendor-agnostic source of truth for the InteractiveTerminal trace gutter.
 * Subscribes to a single `AgenticProcess.flowDataStream` (history + live +
 * sniffer, merged + deduplicated by the worker drivers and listen.py
 * fan-out) and surfaces it as `TraceEvent[]`. Renders for both Claude and
 * Codex tabs without any vendor branch.
 *
 * Stability contract: the returned `events` array reference is stable across
 * renders that didn't change the underlying stream content. This is
 * load-bearing — the InteractiveTerminal threads `events` (and a derived
 * `lastMessageTime`) through props that ultimately reach Radix Tooltip
 * children, where ref churn would trigger an infinite render loop. The
 * stability comes from `useAgenticProcessStream`'s `useSyncExternalStore`
 * snapshot.
 */

import { useEffect, useMemo, useRef } from 'react';
import { AgenticProcess, FlowDataSource } from '@sdk';
import { useAgenticProcessStream } from './use-agentic-process-stream';
import {
  mapFlowDataToTraceEvent,
  type TraceEvent,
} from '@src/types/trace-event';

export interface UseFlowDataTraceResult {
  events: TraceEvent[];
  historicalCount: number;
  liveCount: number;
  sessionStartTime: string | null;
}

const EMPTY: TraceEvent[] = [];

export function useFlowDataTrace(
  process: AgenticProcess | null,
): UseFlowDataTraceResult {
  // One-shot history load on process attach. AgenticProcess.loadHistory
  // dedups concurrent + repeat calls (`_historyLoaded`/`_historyLoading`).
  const loadAttemptedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!process) {
      loadAttemptedRef.current = null;
      return;
    }
    if (loadAttemptedRef.current === process.id) return;
    loadAttemptedRef.current = process.id;
    void process.loadHistory().catch((err: unknown) => {
      console.error('[useFlowDataTrace] loadHistory failed', err);
    });
  }, [process?.id]);

  const flowData = useAgenticProcessStream(process);
  const sessionId = process?.session_id ?? '';

  const events = useMemo<TraceEvent[]>(() => {
    if (!sessionId || flowData.length === 0) return EMPTY;
    const mapped = flowData.map((fd) => mapFlowDataToTraceEvent(fd, sessionId));
    mapped.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return mapped;
  }, [flowData, sessionId]);

  const counts = useMemo(() => {
    let h = 0;
    let l = 0;
    for (const fd of flowData) {
      if (fd.source === FlowDataSource.History) h += 1;
      else l += 1;
    }
    return { h, l };
  }, [flowData]);

  const sessionStartTime = useMemo<string | null>(() => {
    if (events.length === 0) return null;
    return events[0].timestamp || null;
  }, [events]);

  return {
    events,
    historicalCount: counts.h,
    liveCount: counts.l,
    sessionStartTime,
  };
}
