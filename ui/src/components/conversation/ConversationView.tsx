import { useCallback, useMemo } from 'react';
import { Conversation, TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import type { ITask } from '@sdk/entities/task';
import { FlowMessageBubble } from './FlowMessageBubble';
import { MessageComposer } from './MessageComposer';
import { useApproveAndExecute } from './useApproveAndExecute';

interface ConversationViewProps {
  conversationId: string;
  /** Optional. Task-bound conversations (inbound .flowmsg) pass it; project-scoped do not. */
  task?: ITask | null;
  senderName?: string;
  /** Wraps any action that needs a `cwd`/project. Provided by the parent (SharedTaskView / TaskDetailPanel). */
  ensureMapped?: (continuation: () => void | Promise<void>) => void;
}

export function ConversationView({
  conversationId,
  task,
  senderName: _senderName,
  ensureMapped,
}: ConversationViewProps) {
  const { data: conversation, refetch } = useEntity<Conversation>(
    new TypeId(Conversation.type, conversationId),
  );

  const pointers = conversation?.conversationMessageIds ?? [];

  // Approve & Execute is task-bound. Pass an inert task to the hook when no
  // task is present so we can keep the call unconditional, then suppress the
  // approve action below.
  const inertTask = useMemo(() => ({ id: '', metadata: {} }) as ITask, []);
  const { approveAndExecute } = useApproveAndExecute({ task: task ?? inertTask });

  const runApprove = useCallback(
    (messageId: string, idx: number) => {
      if (!task) return;
      const action = async () => {
        await approveAndExecute(messageId, idx);
        void refetch();
      };
      if (ensureMapped) ensureMapped(action);
      else void action();
    },
    [approveAndExecute, refetch, ensureMapped, task],
  );

  return (
    <div className="space-y-3">
      {pointers.length === 0 ? (
        <p className="text-xs italic text-muted-foreground/60">No messages yet.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {pointers.map((ptr) => (
            <FlowMessageBubble
              key={ptr.message_id}
              messageId={ptr.message_id}
              timestamp={ptr.timestamp}
              task={task}
              onApproveAndExecute={task ? runApprove : undefined}
            />
          ))}
        </div>
      )}

      <MessageComposer
        task={task}
        conversationId={conversationId}
        onSent={() => void refetch()}
      />
    </div>
  );
}
