import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Conversation, dataManager, FlowMessage, QueryFilter, QueryRequest, TypeId } from '@sdk';
import { useEntitiesQuery, useEntity } from '@sdk/react/hooks';
import type { ITask } from '@sdk/entities/task';
import { openInboxMessage } from '@src/components/inbox-view/inbox-api';
import { FlowMessageBubble } from './FlowMessageBubble';
import { MessageComposer } from './MessageComposer';
import { useApproveAndExecutePty } from './useApproveAndExecutePty';
import { useApproveAndExecuteHeadless } from './useApproveAndExecuteHeadless';
import { useLocalUser } from './useLocalUser';
import { ConversationMode } from './conversation-mode';
import { buildConversationItems, ConversationItemKind } from './conversation-items';

export { ConversationMode } from './conversation-mode';

interface ConversationViewProps {
  conversationId: string;
  /** Optional. Task-bound conversations (inbound .flowmsg) pass it; project-scoped do not. */
  task?: ITask | null;
  senderName?: string;
  /** Wraps any action that needs a `cwd`/project. Provided by the parent (SharedTaskView / TaskDetailPanel). */
  ensureMapped?: (continuation: () => void | Promise<void>) => void;
  mode?: ConversationMode;
}

export function ConversationView({
  conversationId,
  task,
  senderName: _senderName,
  ensureMapped,
  mode = ConversationMode.HEADLESS,
}: ConversationViewProps) {
  const { data: conversation, refetch } = useEntity<Conversation>(
    new TypeId(Conversation.type, conversationId),
  );
  const { localUser } = useLocalUser();

  const pointers = conversation?.conversationMessageIds ?? [];

  // Local-only drafts attached to this conversation. Filtered to the local
  // user so a counterparty's stray draft never renders here.
  const draftsRequest = useMemo(
    () => new QueryRequest({
      type: FlowMessage.type,
      scope: [],
      name: `drafts:${conversationId}`,
      query: new QueryFilter({
        match: {
          conversation_id: conversationId,
          is_draft: true,
          ...(localUser?.id ? { sender_id: localUser.id } : {}),
        } as Record<string, unknown>,
      }),
    }),
    [conversationId, localUser?.id],
  );
  const { data: draftMessages = [] } = useEntitiesQuery<FlowMessage>(draftsRequest, {
    enabled: !!conversationId,
  });

  // Backfill missing FlowMessage entities. `backfilledIds` tracks ids whose
  // bundle finished unpacking — adding an id flips the bubble's React key,
  // forcing a one-shot remount so its `useEntity` re-fetches. Without this,
  // a bubble that 404'd on first mount (FM not yet materialized) would never
  // re-attempt and stay stuck on "Loading message…".
  const requestedRef = useRef<Set<string>>(new Set());
  const [backfilledIds, setBackfilledIds] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    if (pointers.length === 0) return;
    let cancelled = false;
    (async () => {
      for (const ptr of pointers) {
        if (cancelled) return;
        if (requestedRef.current.has(ptr.message_id)) continue;
        const fmTypeId = new TypeId(FlowMessage.type, ptr.message_id);
        const local = await dataManager.getByTypeId<FlowMessage>(fmTypeId).catch(() => null);
        if (local) continue;
        requestedRef.current.add(ptr.message_id);
        try {
          await openInboxMessage(ptr.message_id);
          if (cancelled) return;
          setBackfilledIds((prev) => {
            if (prev.has(ptr.message_id)) return prev;
            const next = new Set(prev);
            next.add(ptr.message_id);
            return next;
          });
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
  const { approveAndExecute: approveAndExecutePty } = useApproveAndExecutePty({ task: task ?? inertTask });
  const { approveAndExecute: approveAndExecuteHeadless } = useApproveAndExecuteHeadless({ task: task ?? inertTask });

  const runApprove = useCallback(
    (messageId: string, idx: number) => {
      if (!task) return;
      const action = async () => {
        if (mode === ConversationMode.HEADLESS) {
          await approveAndExecuteHeadless(messageId, idx);
        } else {
          await approveAndExecutePty(messageId, idx);
        }
        void refetch();
      };
      if (ensureMapped) ensureMapped(action);
      else void action();
    },
    [approveAndExecuteHeadless, approveAndExecutePty, mode, refetch, ensureMapped, task],
  );

  const orderedItems = useMemo(
    () => buildConversationItems(pointers, draftMessages, backfilledIds),
    [pointers, backfilledIds, draftMessages],
  );

  return (
    <div className="space-y-3">
      {orderedItems.length === 0 ? (
        <p className="text-xs italic text-muted-foreground/60">No messages yet.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {orderedItems.map((item) =>
            item.kind === ConversationItemKind.POINTER ? (
              <FlowMessageBubble
                key={item.key}
                messageId={item.messageId}
                timestamp={item.timestamp}
                task={task}
                onApproveAndExecute={task ? runApprove : undefined}
              />
            ) : (
              <FlowMessageBubble
                key={item.key}
                messageId={item.draft.id ?? ''}
                timestamp={item.draft.created_date instanceof Date
                  ? item.draft.created_date.toISOString()
                  : (item.draft.created_date ?? '')}
                task={task}
                isDraft
                onDraftSent={() => void refetch()}
              />
            ),
          )}
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
