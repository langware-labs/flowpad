import { Conversation, TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import type { ITask } from '@sdk/entities/task';
import { FlowMessageBubble } from './FlowMessageBubble';
import { MessageComposer } from './MessageComposer';

interface ConversationViewProps {
  conversationId: string;
  task: ITask;
}

export function ConversationView({ conversationId, task }: ConversationViewProps) {
  const { data: conversation } = useEntity<Conversation>(
    new TypeId(Conversation.type, conversationId),
  );

  const pointers = conversation?.conversationMessageIds ?? [];

  return (
    <div className="space-y-3">
      {pointers.length === 0 ? (
        <p className="text-xs italic text-muted-foreground/60">No messages yet.</p>
      ) : (
        <div className="space-y-2">
          {pointers.map((ptr) => (
            <FlowMessageBubble
              key={ptr.message_id}
              messageId={ptr.message_id}
              timestamp={ptr.timestamp}
              task={task}
            />
          ))}
        </div>
      )}
      <MessageComposer task={task} />
    </div>
  );
}
