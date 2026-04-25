/**
 * Stub — kept only to satisfy stale HMR module references after the
 * trace-gutter refactor was reverted. Not used by any current component.
 */

import type { AgenticProcess } from '@sdk';
import type { ClaudeTraceEvent as TraceEvent } from '@src/types/trace-event';

export interface UseFlowDataTraceResult {
  events: TraceEvent[];
  historicalCount: number;
  liveCount: number;
  sessionStartTime: string | null;
}

const EMPTY: TraceEvent[] = [];

export function useFlowDataTrace(_process: AgenticProcess | null): UseFlowDataTraceResult {
  return { events: EMPTY, historicalCount: 0, liveCount: 0, sessionStartTime: null };
}
