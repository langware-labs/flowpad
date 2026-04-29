import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Conversation, dataManager, FlowMessage, TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import type { ITask } from '@sdk/entities/task';
import { openInboxMessage } from '@src/components/inbox-view/inbox-api';
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

  // Backfill missing FlowMessage entities
  const requestedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (pointers.length === 0) return;
    let cancelled = false;
    (async () => {
      for (const ptr of pointers) {
        if (cancelled) return;
        if (requestedRef.current.has(ptr.message_id)) continue;
        const local = await dataManager
          .getByTypeId<FlowMessage>(new TypeId(FlowMessage.type, ptr.message_id))
          .catch(() => null);
        if (local) continue;
        requestedRef.current.add(ptr.message_id);
        try {
          await openInboxMessage(ptr.message_id);
        } catch {
          // Drop from the set so a future render can retry once the user
          // refreshes; avoid hammering the hub on transient failures.
          requestedRef.current.delete(ptr.message_id);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // We deliberately key on the joined pointer list (not `pointers` identity)
    // so brand-new replies trigger a fetch but identical re-renders don't.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pointers.map((p) => p.message_id).join(',')]);

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
