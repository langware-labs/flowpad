import { X } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import { AgenticProcess, Conversation, FlowMessage, TypeId } from '@sdk';
import { ContextEntityChip } from './EntityChip';

/**
 * The session started on this message from its ⋮ launch bar (`useMessageSessions`). The X
 * detaches it: the message comes off the session's context and the session off the
 * conversation's, so it is no longer this message's or the conversation's session.
 */
export function MessageSessionChip({
  session,
  messageId,
  conversationId,
}: {
  session: AgenticProcess;
  messageId: string;
  conversationId: string;
}) {
  const { t } = useLingui();
  const label = t`Remove session from this message`;
  const processTid = new TypeId(AgenticProcess.type, session.id);

  const detach = () =>
    Promise.allSettled([
      session.unshareContextEntities(new TypeId(FlowMessage.type, messageId)),
      Conversation.getById<Conversation>(conversationId).then((conv) => conv?.unshareContextEntities(processTid)),
    ]).then((results) =>
      results.forEach((r) => r.status === 'rejected' && console.error('[MessageSessionChip] detach failed', r.reason)),
    );

  return (
    <span className="mt-1 inline-flex items-center gap-0.5" data-testid="message-session-chip">
      <ContextEntityChip typeId={processTid} inside={{ type: 'conversation', id: conversationId }} />
      <button
        type="button"
        onClick={() => void detach()}
        title={label}
        aria-label={label}
        data-testid="message-session-detach"
        className="flex h-4 w-4 items-center justify-center rounded text-muted-foreground hover:bg-muted"
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}
