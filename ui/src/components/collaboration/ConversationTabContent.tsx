import { Conversation, Task, TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { FlowMessageBubble } from '@src/components/conversation/FlowMessageBubble';
import { MessageComposer } from '@src/components/conversation/MessageComposer';

interface ConversationTabContentProps {
  conversationId: string;
}

export function ConversationTabContent({ conversationId }: ConversationTabContentProps) {
  const { data: conversation, refetch } = useEntity<Conversation>(
    conversationId ? new TypeId(Conversation.type, conversationId) : null,
  );
  const { data: task } = useEntity<Task>(
    conversation?.task_id ? new TypeId(Task.type, conversation.task_id) : null,
  );

  if (!conversation) {
    return <div className="p-4 text-xs text-muted-foreground">Loading conversation…</div>;
  }

  const pointers = conversation.conversationMessageIds ?? [];

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-4 space-y-2">
        {pointers.length === 0 ? (
          <p className="text-xs italic text-muted-foreground/60">No messages yet.</p>
        ) : (
          pointers.map((ptr) =>
            task ? (
              <FlowMessageBubble
                key={ptr.message_id}
                messageId={ptr.message_id}
                timestamp={ptr.timestamp}
                task={task}
              />
            ) : null,
          )
        )}
      </div>
      {task && (
        <div className="border-t p-3">
          <MessageComposer task={task} onSent={() => void refetch()} />
        </div>
      )}
    </div>
  );
}
