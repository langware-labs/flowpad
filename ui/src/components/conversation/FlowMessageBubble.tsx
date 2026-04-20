import { FlowMessage, TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import type { ITask } from '@sdk/entities/task';
import type { ConversationMessage } from '@sdk/entities/conversation';
import { MessageBubble } from './MessageBubble';

interface FlowMessageBubbleProps {
  messageId: string;
  timestamp: string;
  task: ITask;
}

export function FlowMessageBubble({ messageId, timestamp, task }: FlowMessageBubbleProps) {
  const { data: fm } = useEntity<FlowMessage>(
    new TypeId(FlowMessage.type, messageId),
  );

  if (!fm) return null;

  const role =
    fm.sender_id && task.shared_by_id && fm.sender_id === task.shared_by_id
      ? 'sender'
      : 'recipient';

  const message: ConversationMessage = {
    role,
    content: fm.text ?? '',
    sender_id: fm.sender_id ?? '',
    timestamp,
  };

  return (
    <MessageBubble
      message={message}
      flowMessageId={messageId}
      senderName={fm.sender_name ?? ''}
    />
  );
}
