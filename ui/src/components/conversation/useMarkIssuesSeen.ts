import { useEffect, useRef } from 'react';
import { markFlowMessagesReceived, type FlowMessage } from '@sdk';
import { isMonitoringKind } from '@sdk/entities/conversation';
import { authoredBy, senderOf } from '@sdk/models/MessageSender';

/**
 * Open-to-seen for a Monitoring conversation: while it is open and focused, tell the hub this member has
 * received its issue messages (`mark_received`); the hub moves each open issue to "seen". Only issue
 * messages not yet received and not our own are sent, each once per mount (a failure retries on focus).
 */
export function useMarkIssuesSeen(
  conversationKind: string | null | undefined,
  messages: ReadonlyMap<string, FlowMessage>,
  selfIds: Array<string | null | undefined>,
): void {
  const sentRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!isMonitoringKind(conversationKind)) return;
    const markSeen = () => {
      if (!document.hasFocus()) return;
      const ids: string[] = [];
      for (const fm of messages.values()) {
        if (!fm.id || !fm.issue_reply || fm.delivery_status === 'received') continue;
        if (sentRef.current.has(fm.id) || authoredBy(senderOf(fm), selfIds)) continue;
        ids.push(fm.id);
      }
      if (ids.length === 0) return;
      ids.forEach((id) => sentRef.current.add(id));
      void markFlowMessagesReceived(ids).catch(() => {
        ids.forEach((id) => sentRef.current.delete(id)); // transient failure — retry on next focus
      });
    };
    markSeen();
    window.addEventListener('focus', markSeen);
    return () => window.removeEventListener('focus', markSeen);
  }, [conversationKind, messages, selfIds]);
}
