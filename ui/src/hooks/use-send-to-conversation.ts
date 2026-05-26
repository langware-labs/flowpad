import { useCallback, useRef, useState } from 'react';
import {
  Conversation,
  createAndSendConversation,
  getErrorMessagesFromAxios,
  sendToExistingConversation,
  type ConversationSendPayload,
  type CreateAndSendParams,
} from '@sdk';
import { useCloudLoginGate } from './use-cloud-login-gate';

export type SendTarget =
  | { kind: 'existing'; conversationId: string }
  | { kind: 'new'; params: CreateAndSendParams };

/**
 * Shared "send a message into a conversation (existing or new)" hook.
 *
 * Both NewConversationDialog and ShareToConversationDialog consume this so
 * the re-entry lock, retry-stable draft id, and cloud-login gate live in one
 * place instead of being duplicated per dialog.
 */
export function useSendToConversation() {
  const ensureCloudLogin = useCloudLoginGate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Synchronous re-entry lock — `busy` state lags one render on double-clicks.
  const submittingRef = useRef(false);
  // Stable draft across retries (see createAndSendConversation).
  const draftRef = useRef<Conversation | null>(null);

  const send = useCallback(
    async (
      target: SendTarget,
      payload: ConversationSendPayload,
    ): Promise<string | null> => {
      if (submittingRef.current) return null;
      submittingRef.current = true;
      setBusy(true);
      setError(null);
      try {
        if (target.kind === 'existing') {
          await sendToExistingConversation(target.conversationId, payload);
          return target.conversationId;
        }
        const r = await createAndSendConversation(target.params, payload, {
          ensureCloudLogin,
          draftRef,
        });
        return r.conversation_id;
      } catch (err: unknown) {
        const fromAxios = await getErrorMessagesFromAxios(err);
        const msg =
          fromAxios || (err instanceof Error ? err.message : '') || 'Failed to send';
        setError(msg);
        return null;
      } finally {
        submittingRef.current = false;
        setBusy(false);
      }
    },
    [ensureCloudLogin],
  );

  const resetDraft = useCallback(() => {
    draftRef.current = null;
  }, []);

  return { send, busy, error, resetDraft };
}
