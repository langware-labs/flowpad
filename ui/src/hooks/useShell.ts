import { Shell, type ShellSnapshot } from '@sdk';
import { useCallback, useEffect, useSyncExternalStore, useState } from 'react';

const defaultSnapshot: ShellSnapshot = { replayDone: false };

/**
 * Resolves a Shell entity by ID and exposes its reactive store snapshot.
 *
 * Returns { shell, connected, replayDone } where replayDone comes from
 * Shell's snapshot store and connected is read directly from shell.connected.
 */
export function useShell(shellId: string | null | undefined): {
  shell: Shell | null;
  connected: boolean;
  replayDone: boolean;
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

  const subscribe = useCallback(
    (cb: () => void) => shell?.subscribe(cb) ?? (() => {}),
    [shell],
  );
  const getSnapshot = useCallback(
    () => shell?.getSnapshot() ?? defaultSnapshot,
    [shell],
  );

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return { shell, connected: shell?.connected ?? false, ...snapshot };
}
