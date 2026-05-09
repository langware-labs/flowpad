import { ConnectionManager } from '@sdk';
import { useEffect } from 'react';

/**
 * Report per-tab presence (visible + focused) to the server so the backend
 * can pick a single "active" tab for agent-directed navigation.
 *
 * - Reads initial state from `document.hidden` and `document.hasFocus()`.
 * - Listens for `visibilitychange`, window `focus` / `blur`.
 * - Debounces 100ms to collapse rapid alt-tab flaps.
 * - Re-sends on every WS (re-)open so the server doesn't linger on the
 *   default `true/true` after a hidden-tab reconnect.
 *
 * Mount exactly once at the app root. Safe to no-op when the socket
 * is not yet connected — the `on_open` listener handles the first send.
 */
export function usePresenceReporter(): void {
  useEffect(() => {
    const cm = ConnectionManager.getInstance();
    let lastSent: { visible: boolean; focused: boolean } | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const readState = () => ({
      visible: !document.hidden,
      focused: document.hasFocus(),
    });

    const sendNow = (force: boolean) => {
      if (!cm.connected) return;
      const current = readState();
      if (
        !force &&
        lastSent !== null &&
        lastSent.visible === current.visible &&
        lastSent.focused === current.focused
      ) {
        return;
      }
      try {
        cm.send(
          JSON.stringify({
            message_type: 'presence',
            message_id: crypto.randomUUID(),
            visible: current.visible,
            focused: current.focused,
          }),
        );
        lastSent = current;
      } catch {
        // Socket may have dropped between the `connected` check and send.
        // Next on_open re-sends forcibly, so no retry needed here.
      }
    };

    const schedule = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        sendNow(false);
      }, 100);
    };

    const onVisibility = () => schedule();
    const onFocus = () => schedule();
    const onBlur = () => schedule();

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);

    // Every (re-)connect starts a fresh server record at the default
    // true/true — we must re-send the real state even if it hasn't
    // changed since our last dispatch, or a reconnect-while-hidden tab
    // will look visible to the server.
    const resend = () => {
      lastSent = null;
      sendNow(true);
    };
    cm.on('on_open', resend);
    cm.on('on_reconnected', resend);

    if (cm.connected) {
      sendNow(true);
    }

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
      cm.off('on_open', resend);
      cm.off('on_reconnected', resend);
      if (timer !== null) clearTimeout(timer);
    };
  }, []);
}
