import { usePendingActions } from '@src/store/pending-actions-store';
import { useEffect, useRef, useState } from 'react';

/**
 * Returns true for `durationMs` after each time a new id enters the
 * pending (ready-for-input) set during the current session. Mirrors the
 * mount-time gate used by `usePendingCompletionSound` so the chip pulse
 * and the sound fire on the exact same trigger and stay silent on cold
 * page reload.
 *
 * If a second new id arrives while still pulsing, the timer is reset
 * via cleanup + re-fire — the user sees one continuous pulse from the
 * most recent notification rather than a stutter.
 */
export function useNotificationPulse(durationMs = 3000): boolean {
  const pendingEntries = usePendingActions();
  const mountedAtRef = useRef<number>(Date.now());
  const seenRef = useRef<Map<string, number>>(new Map());
  const [pulsing, setPulsing] = useState(false);

  useEffect(() => {
    let hasNew = false;
    const currentIds = new Set<string>();
    for (const e of pendingEntries) {
      currentIds.add(e.processId);
      if (seenRef.current.get(e.processId) === e.readyAt) continue;
      seenRef.current.set(e.processId, e.readyAt);
      if (e.readyAt > mountedAtRef.current) hasNew = true;
    }
    for (const id of seenRef.current.keys()) {
      if (!currentIds.has(id)) seenRef.current.delete(id);
    }
    if (!hasNew) return;
    setPulsing(true);
    const t = setTimeout(() => setPulsing(false), durationMs);
    return () => clearTimeout(t);
  }, [pendingEntries, durationMs]);

  return pulsing;
}
