import { ActionInfo, dataManager, FlowMessage } from '@sdk';
import { useCallback, useEffect, useState } from 'react';

/** Whether the signed-in user has a FlowPad desktop connected to the hub right now. */
export type DesktopPresence = 'checking' | 'online' | 'offline';

/** Asks the hub (`current-user-desktops`) once on mount, and again on `recheck()`. A failed ask reads as offline. */
export function useDesktopPresence(enabled: boolean): { presence: DesktopPresence; recheck: () => void } {
  const [presence, setPresence] = useState<DesktopPresence>('checking');
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setPresence('checking');
    void dataManager
      .callAction<void, { online?: boolean }>(new ActionInfo('current-user-desktops', null, null, 'GET'))
      .then((data) => live && setPresence(data?.online ? 'online' : 'offline'))
      .catch(() => live && setPresence('offline'));
    return () => {
      live = false;
    };
  }, [enabled, round]);
  return { presence, recheck: useCallback(() => setRound((n) => n + 1), []) };
}

/** Ask the hub to open the message on the user's connected desktop(s). Resolves how many it reached. */
export async function openOnDesktop(messageId: string): Promise<number> {
  const action = new ActionInfo('open_on_desktop', FlowMessage.type, null, 'POST');
  action.bodyParameters = { flow_message_id: messageId };
  const data = await dataManager.callAction<unknown, { delivered?: number }>(action);
  return data?.delivered ?? 0;
}
