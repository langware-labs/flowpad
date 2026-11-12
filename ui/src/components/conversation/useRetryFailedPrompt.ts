import { sendReply } from '@sdk/entities/notifications';
import { useCallback } from 'react';
import { useCloudLoginGate } from '@src/hooks/use-cloud-login-gate';
import { notify } from '@src/notifications/notify';
import { buildSessionStartExtras } from './session-start';

/**
 * Send a prompt's text again. With a session id it is a new turn in the SAME session — the
 * path a follow-up typed in the session view takes (a failed prompt's Retry). With none it
 * is a new prompt request (a finished request's Run again), which the host approves like
 * the first. Travels hub-optional like any other turn.
 */
export function useRetryFailedPrompt(): (conversationId: string, sessionId: string | null, text: string) => Promise<void> {
  const ensureCloudLogin = useCloudLoginGate();
  return useCallback(
    async (conversationId: string, sessionId: string | null, text: string) => {
      const gate = await ensureCloudLogin();
      if (!gate.ok) {
        notify.error({ title: gate.error, forceToast: true });
        return;
      }
      await sendReply(
        { conversationId },
        '',
        undefined,
        buildSessionStartExtras({ text, files: [], sessionId }),
      );
    },
    [ensureCloudLogin],
  );
}
