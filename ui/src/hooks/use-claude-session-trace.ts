import { useState, useEffect, useRef, useMemo } from 'react';
import { ClaudeSessionRecord } from '@sdk/resource_management/fs_records/claude/claude-session.js';
import type { TranscriptEntryData } from '@src/types/trace-event';
import type { ClaudeTraceEvent } from '@src/types/trace-event';
import { mapSnifferToTraceEvent, mapTranscriptToTraceEvents } from '@src/types/trace-event';
import { useProcessSniffer } from './use-process-sniffer';

// Sentinel that can never match a real session_id — used when sessionId is null
// so useProcessSniffer (an unconditional hook) stays mounted but returns nothing.
const NULL_SESSION_SENTINEL = '__null_session__';

export function useClaudeSessionTrace(sessionId: string | null): {
  events: ClaudeTraceEvent[];
  isLoading: boolean;
  historicalCount: number;
  liveCount: number;
  sessionStartTime: string | null;
} {
  const [transcriptEntries, setTranscriptEntries] = useState<TranscriptEntryData[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [sessionStartTime, setSessionStartTime] = useState<string | null>(null);
  const cacheRef = useRef<Map<string, TranscriptEntryData[]>>(new Map());
  const discoveredRef = useRef<Set<string>>(new Set());

  // useProcessSniffer handles accumulation + idx-stable deduplication internally.
  // Pass a sentinel when sessionId is null so the hook is unconditionally mounted.
  const { events: liveSnifferEvents } = useProcessSniffer(sessionId ?? NULL_SESSION_SENTINEL);

  // Fetch transcript via entity layer
  useEffect(() => {
    if (!sessionId) {
      setTranscriptEntries([]);
      return;
    }
    const cached = cacheRef.current.get(sessionId);
    if (cached && cached.length > 0) {
      setTranscriptEntries(cached);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    ClaudeSessionRecord.fetchTranscript(sessionId)
      .then((data) => {
        if (cancelled) return;
        cacheRef.current.set(sessionId, data);
        setTranscriptEntries(data);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => { cancelled = true; };
  }, [sessionId]);

  // Call discovery once per session to get start_time and computed properties
  useEffect(() => {
    if (!sessionId || discoveredRef.current.has(sessionId)) return;
    discoveredRef.current.add(sessionId);
    ClaudeSessionRecord.discover(sessionId)
      .then((record) => {
        if (record?.start_time) {
          setSessionStartTime(record.start_time);
        }
      })
      .catch(() => {/* ignore discovery errors */});
  }, [sessionId]);

  // Map transcript entries to trace events
  const historicalEvents = useMemo(() => {
    if (!sessionId || transcriptEntries.length === 0) return [];
    return transcriptEntries.flatMap((entry) =>
      mapTranscriptToTraceEvents(entry, sessionId),
    );
  }, [transcriptEntries, sessionId]);

  // Map accumulated sniffer events to trace events
  const liveEvents = useMemo(
    () => liveSnifferEvents.map(mapSnifferToTraceEvent),
    [liveSnifferEvents],
  );

  // Merge and sort
  const events = useMemo(() => {
    const merged = [...historicalEvents, ...liveEvents];
    merged.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return merged;
  }, [historicalEvents, liveEvents]);

  return {
    events,
    isLoading,
    historicalCount: historicalEvents.length,
    liveCount: liveEvents.length,
    sessionStartTime,
  };
}
