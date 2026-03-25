import { createContext, useCallback, useContext, useSyncExternalStore } from 'react';
import type { PtySyncSession, PtySyncSnapshot } from '@sdk/pty-sync/PtySyncSession.js';

// Context holds the stable session object, NOT the snapshot
const PtySyncContext = createContext<PtySyncSession | null>(null);

// ── Provider ────────────────────────────────────────────────────────────────

interface PtySyncProviderProps {
  session: PtySyncSession;
  children: React.ReactNode;
}

export function PtySyncProvider({ session, children }: PtySyncProviderProps) {
  return <PtySyncContext.Provider value={session}>{children}</PtySyncContext.Provider>;
}

// ── Hooks ────────────────────────────────────────────────────────────────────

/**
 * Access the PtySyncSession snapshot reactively.
 * Re-renders when version increments (chunk processed, resize, session switch).
 *
 * Must be called inside a <PtySyncProvider>.
 */
export function usePtySync(): PtySyncSnapshot {
  const session = useContext(PtySyncContext);
  if (!session) throw new Error('usePtySync must be used within PtySyncProvider');

  const subscribe = useCallback((cb: () => void) => session.subscribe(cb), [session]);
  const getSnapshot = useCallback(() => session.getSnapshot(), [session]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Access a PtySyncSession snapshot reactively without requiring a PtySyncProvider.
 * Use this when the session object is available directly (e.g. from a ref in the
 * component that also owns the PtySyncProvider).
 */
export function usePtySyncSession(session: PtySyncSession): PtySyncSnapshot {
  const subscribe = useCallback((cb: () => void) => session.subscribe(cb), [session]);
  const getSnapshot = useCallback(() => session.getSnapshot(), [session]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
