import { useEffect, useRef, useState } from 'react';
import { useSnifferContext } from '@src/contexts/SnifferContext';
import type { SnifferEvent } from './use-hooks-sniffer';

/**
 * Accumulates sniffer events for a specific session, surviving ring-buffer eviction.
 * Must be rendered inside a SnifferProvider.
 *
 * Uses `idx` (the stable global offset index) for deduplication rather than `id`
 * (which is position-based and changes when items are trimmed from the stream).
 */
export function useProcessSniffer(sessionId: string): { events: SnifferEvent[] } {
  const { events: snifferEvents } = useSnifferContext();
  const [events, setEvents] = useState<SnifferEvent[]>([]);
  const seenIdxRef = useRef<Set<number>>(new Set());

  // Reset when sessionId changes
  useEffect(() => {
    seenIdxRef.current.clear();
    setEvents([]);
  }, [sessionId]);

  // Accumulate new events for this session — survives ring-buffer eviction.
  // Deduplication is by idx (stable across trims) not id (position-based).
  useEffect(() => {
    const fresh = snifferEvents.filter(
      (e) => e.session_id === sessionId && !seenIdxRef.current.has(e.idx),
    );
    if (fresh.length === 0) return;
    for (const e of fresh) seenIdxRef.current.add(e.idx);
    setEvents((prev) => [...prev, ...fresh]);
  }, [snifferEvents, sessionId]);

  return { events };
}
