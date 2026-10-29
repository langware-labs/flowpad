import { useEffect, useRef } from 'react';
import type { FlowMessage } from '@sdk';
import { authoredBy, senderOf } from '@sdk/models/MessageSender';
import { updateMessage } from '@src/components/stream-inbox-view/stream-inbox-api';

/**
 * Open-to-read: while a view showing `latest` is open, mark it read when it was received —
 * the backend's unread count stops at the newest read message, so this brings the
 * conversation to 0 (StreamInboxManager.unread reconciles after the mutation).
 * Focus-gated: a message arriving while the window is backgrounded stays unread (it drives
 * the badge) until the user actually returns — hence the re-run on window focus.
 */
export function useMarkLatestRead(
  latest: FlowMessage | undefined,
  cloudUserId: string | null | undefined,
  localUserId: string | null | undefined,
  agentId?: string | null,
): void {
  const markedRef = useRef<string | null>(null);
  useEffect(() => {
    const markLatestRead = () => {
      if (!document.hasFocus()) return;
      if (!latest?.id || latest.is_read) return;
      if (authoredBy(senderOf(latest), [cloudUserId, localUserId])) return;
      if (markedRef.current === latest.id) return;
      markedRef.current = latest.id;
      void updateMessage(latest.id, { is_read: true }, agentId ?? undefined).catch(() => {
        markedRef.current = null; // transient failure — retry on next tick/focus
      });
    };
    markLatestRead();
    window.addEventListener('focus', markLatestRead);
    return () => window.removeEventListener('focus', markLatestRead);
  }, [latest, cloudUserId, localUserId, agentId]);
}
