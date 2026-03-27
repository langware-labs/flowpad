import { Shell } from '@sdk';
import { useCallback, useEffect, useSyncExternalStore, useState } from 'react';

/**
 * Resolves a Shell entity by ID and exposes its reactive connected state.
 *
 * `connected` is driven by Shell 'status' events ('connected' | 'disconnected')
 * and kept in sync via useSyncExternalStore for tearing-free concurrent React.
 */
export function useShell(shellId: string | null | undefined): {
  shell: Shell | null;
  connected: boolean;
} {
  const [shell, setShell] = useState<Shell | null>(null);

  // Resolve Shell entity from SDK cache, with retry
  useEffect(() => {
    if (!shellId) { setShell(null); return; }
    let cancelled = false;
    let retries = 0;
    const resolve = () => {
      Shell.getById(shellId).then((s) => {
        if (cancelled) return;
        if (s) { setShell(s); return; }
        if (retries++ < 5) setTimeout(resolve, 500);
      }).catch(() => {});
    };
    resolve();
    return () => { cancelled = true; };
  }, [shellId]);

  // Subscribe to Shell 'status' events so useSyncExternalStore re-reads shell.connected
  const subscribe = useCallback(
    (cb: () => void) => shell?.on('status', () => cb()) ?? (() => {}),
    [shell],
  );
  const getSnapshot = useCallback(
    () => shell?.connected ?? false,
    [shell],
  );

  const connected = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return { shell, connected };
}
