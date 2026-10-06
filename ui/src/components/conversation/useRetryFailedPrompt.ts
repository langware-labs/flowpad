import { sendReply } from '@sdk/entities/notifications';
import { useCallback } from 'react';
import { useCloudLoginGate } from '@src/hooks/use-cloud-login-gate';
import { notify } from '@src/notifications/notify';
import { buildSessionStartExtras } from './session-start';

/**
 * Retry a failed live-session prompt: send its text again as a new prompt in the
 * SAME session — the exact path a follow-up typed in the session view takes, so it
 * travels hub-optional like any other turn. Shared by the session view's failed
 * line and the conversation's session card.
 */
export function useRetryFailedPrompt(): (conversationId: string, sessionId: string, text: string) => Promise<void> {
  const ensureCloudLogin = useCloudLoginGate();
  return useCallback(
    async (conversationId: string, sessionId: string, text: string) => {
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
