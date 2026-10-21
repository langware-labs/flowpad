import { ActionInfo, ConnectionManager, dataManager } from '@sdk';
import { useCallback, useEffect, useState } from 'react';

/** Whether the signed-in user has a FlowPad desktop connected to the hub right now.
 *  `unknown` = the hub could not answer (an older hub without `current-user-desktops`). */
export type DesktopPresence = 'checking' | 'online' | 'offline' | 'unknown';

/**
 * Asks the hub (`current-user-desktops`) on mount, on `recheck()`, and again whenever the
 * hub says one of the user's desktops connected or left (`on_desktop_presence`) or this
 * tab's socket reconnects — so the page follows the desktop without a reload.
 */
export function useDesktopPresence(enabled: boolean): { presence: DesktopPresence; recheck: () => void } {
  const [presence, setPresence] = useState<DesktopPresence>('checking');
  const [round, setRound] = useState(0);
  const recheck = useCallback(() => setRound((n) => n + 1), []);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setPresence('checking');
    void dataManager
      .callAction<void, { online?: boolean }>(new ActionInfo('current-user-desktops', null, null, 'GET'))
      .then((data) => live && setPresence(data?.online ? 'online' : 'offline'))
      .catch(() => live && setPresence('unknown'));
    return () => {
      live = false;
    };
  }, [enabled, round]);

  useEffect(() => {
    if (!enabled) return;
    // A desktop that reconnects sends "left", "connected" and this tab's own reconnect in a burst:
    // one check after the burst answers all of them.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const soon = () => {
      clearTimeout(timer);
      timer = setTimeout(recheck, 250);
    };
    const cm = ConnectionManager.getInstance();
    cm.on('on_desktop_presence', soon);
    cm.on('on_reconnected', soon);
    return () => {
      clearTimeout(timer);
      cm.off('on_desktop_presence', soon);
      cm.off('on_reconnected', soon);
    };
  }, [enabled, recheck]);

  return { presence, recheck };
}
