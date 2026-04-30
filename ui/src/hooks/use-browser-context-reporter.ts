import { ConnectionManager, ContextEntitiesEnum, dataContext } from '@sdk';
import { autorun } from 'mobx';
import { useEffect } from 'react';

/**
 * Mirror the UI's per-tab data-context (current project / process /
 * workspace TypeIds, etc.) to the backend so agents can read it via
 * `flow context list` and compose actions like "navigate to current
 * project" without asking the user for an id.
 *
 * Pairs with `usePresenceReporter`: same one-way fire-and-forget WS
 * pattern, debounced + re-sent on every reconnect so a context update
 * that landed during a socket gap doesn't get lost.
 *
 * Mount exactly once at the app root.
 */
export function useBrowserContextReporter(): void {
  useEffect(() => {
    const cm = ConnectionManager.getInstance();
    let lastSerialized: string | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const snapshot = (): Record<string, string | null> => {
      const out: Record<string, string | null> = {};
      for (const key of Object.values(ContextEntitiesEnum)) {
        const typeId = dataContext.getContextEntityTypeId(key);
        out[key] = typeId ? typeId.toString() : null;
      }
      return out;
    };

    const sendNow = (force: boolean) => {
      if (!cm.connected) return;
      const ctx = snapshot();
      const serialized = JSON.stringify(ctx);
      if (!force && serialized === lastSerialized) return;
      try {
        cm.send(
          JSON.stringify({
            message_type: 'browser_context',
            message_id: crypto.randomUUID(),
            context: ctx,
          }),
        );
        lastSerialized = serialized;
      } catch {
        // Socket may have dropped; on_open re-sends forcibly.
      }
    };

    const schedule = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        sendNow(false);
      }, 100);
    };

    // mobx autorun fires once immediately, then on every observed change.
    // Touching each observable getter inside the closure registers it.
    const stopAutorun = autorun(() => {
      for (const key of Object.values(ContextEntitiesEnum)) {
        dataContext.getContextEntityTypeId(key);
      }
      schedule();
    });

    const resend = () => {
      lastSerialized = null;
      sendNow(true);
    };
    cm.on('on_open', resend);
    cm.on('on_reconnected', resend);

    if (cm.connected) sendNow(true);

    return () => {
      stopAutorun();
      cm.off('on_open', resend);
      cm.off('on_reconnected', resend);
      if (timer !== null) clearTimeout(timer);
    };
  }, []);
}
