import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Conversation, dataManager, FlowMessage, QueryFilter, QueryRequest, syncFromHub, TypeId } from '@sdk';
import { useEntitiesQuery, useEntity } from '@sdk/react/hooks';
import type { ITask } from '@sdk/entities/task';
import { openInboxMessage } from '@src/components/inbox-view/inbox-api';
import { FlowMessageBubble } from './FlowMessageBubble';
import { MessageComposer } from './MessageComposer';
import { useApproveAndExecute } from './useApproveAndExecute';
import { useLocalUser } from './useLocalUser';
import { buildConversationItems, ConversationItemKind } from './conversation-items';

interface ConversationViewProps {
  conversationId: string;
  /** Optional. Task-bound conversations (inbound .flowmsg) pass it; project-scoped do not. */
  task?: ITask | null;
  senderName?: string;
  /** Wraps any action that needs a `cwd`/project. Provided by the parent (SharedTaskView / TaskDetailPanel). */
  ensureMapped?: (continuation: () => void | Promise<void>) => void;
  /** ID of the currently-selected message (for the Context drawer tab). */
  selectedMessageId?: string | null;
  /** Called when the user clicks (or starts editing) a message. */
  onSelectMessage?: (messageId: string) => void;
  /** Reports the most recent message id so the parent can default-select it. */
  onMostRecentMessageChange?: (messageId: string | null) => void;
}

export function ConversationView({
  conversationId,
  task,
  senderName: _senderName,
  ensureMapped,
  selectedMessageId,
  onSelectMessage,
  onMostRecentMessageChange,
}: ConversationViewProps) {
  const { data: conversation, refetch } = useEntity<Conversation>(
    new TypeId(Conversation.type, conversationId),
  );
  const { localUser } = useLocalUser();

  const pointers = conversation?.conversationMessageIds ?? [];

  // Local-only drafts attached to this conversation. Filtered to the local
  // user so a counterparty's stray draft never renders here. Match is built
  // as an explicit $AND/$EQ tree — the SDK's multi-key plain-object shorthand
  // doesn't recursively wrap operands, which makes real-time validate() crash.
  const draftsRequest = useMemo(() => {
    const eqClauses: Array<{ op: string; operands: unknown[] }> = [
      { op: '$EQ', operands: ['conversation_id', conversationId] },
      { op: '$EQ', operands: ['is_draft', true] },
    ];
    if (localUser?.id) {
      eqClauses.push({ op: '$EQ', operands: ['sender_id', localUser.id] });
    }
    return new QueryRequest({
      type: FlowMessage.type,
      scope: [],
      name: `drafts:${conversationId}`,
      query: new QueryFilter({
        match: { op: '$AND', operands: eqClauses } as Record<string, unknown>,
      }),
    });
  }, [conversationId, localUser?.id]);
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
        if (requestedRef.current.has(ptr.id)) continue;
        const fmTypeId = new TypeId(FlowMessage.type, ptr.id);
        const local = await dataManager.getByTypeId<FlowMessage>(fmTypeId).catch(() => null);
        if (local) continue;
        requestedRef.current.add(ptr.id);
        try {
          await openInboxMessage(ptr.id);
          if (cancelled) return;
          setBackfilledIds((prev) => {
            if (prev.has(ptr.id)) return prev;
            const next = new Set(prev);
            next.add(ptr.id);
            return next;
          });
        } catch {
          // Drop from the set so a future render can retry once the user
          // refreshes; avoid hammering the hub on transient failures.
          requestedRef.current.delete(ptr.id);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // We deliberately key on the joined pointer list (not `pointers` identity)
    // so brand-new replies trigger a fetch but identical re-renders don't.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pointers.map((p) => p.id).join(',')]);

  // Approve & Execute is task-bound. Pass an inert task to the hook when no
  // task is present so we can keep the call unconditional, then suppress the
  // approve action below.
  const inertTask = useMemo(() => ({ id: '', metadata: {} }) as ITask, []);
  const { approveAndExecute } = useApproveAndExecute({
    task: task ?? inertTask,
    conversationId,
  });

  const canApproveAndExecute = !!task || !!conversationId;

  const runApprove = useCallback(
    (messageId: string, idx: number) => {
      if (!canApproveAndExecute) return;
      const action = async () => {
        await approveAndExecute(messageId, idx);
        void refetch();
      };
      if (ensureMapped) ensureMapped(action);
      else void action();
    },
    [approveAndExecute, refetch, ensureMapped, canApproveAndExecute],
  );

  const orderedItems = useMemo(
    () => buildConversationItems(pointers, draftMessages, backfilledIds),
    [pointers, backfilledIds, draftMessages],
  );

  // Surface the most-recent message id so the parent's Context tab can default
  // to it when the user hasn't clicked anything yet.
  const mostRecentMessageId = useMemo<string | null>(() => {
    for (let i = orderedItems.length - 1; i >= 0; i--) {
      const item = orderedItems[i];
      const id =
        item.kind === ConversationItemKind.POINTER ? item.messageId : item.draft.id ?? null;
      if (id) return id;
    }
    return null;
  }, [orderedItems]);
  useEffect(() => {
    onMostRecentMessageChange?.(mostRecentMessageId);
  }, [mostRecentMessageId, onMostRecentMessageChange]);

  const [hubSyncing, setHubSyncing] = useState(false);
  const handleRefresh = useCallback(async () => {
    setHubSyncing(true);
    try {
      try {
        await syncFromHub();
      } catch {
        // Hub may be offline / not configured — local refetch still runs.
      }
      await refetch();
    } finally {
      setHubSyncing(false);
    }
  }, [refetch]);

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void handleRefresh()}
          title="Refresh (pulls from hub)"
          data-testid="refresh-conversation-button"
          className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${hubSyncing ? 'animate-spin' : ''}`} />
        </button>
      </div>
      {orderedItems.length === 0 ? (
        <p className="text-xs italic text-muted-foreground/60">No messages yet.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {orderedItems.map((item) => {
            if (item.kind === ConversationItemKind.POINTER) {
              const id = item.messageId;
              return (
                <FlowMessageBubble
                  key={item.key}
                  messageId={id}
                  timestamp={item.timestamp}
                  task={task}
                  onApproveAndExecute={canApproveAndExecute ? runApprove : undefined}
                  isSelected={selectedMessageId === id}
                  onSelect={onSelectMessage ? () => onSelectMessage(id) : undefined}
                />
              );
            }
            const id = item.draft.id ?? '';
            return (
              <FlowMessageBubble
                key={item.key}
                messageId={id}
                timestamp={item.draft.created_date instanceof Date
                  ? item.draft.created_date.toISOString()
                  : (item.draft.created_date ?? '')}
                task={task}
                isDraft
                onDraftSent={() => void refetch()}
                isSelected={selectedMessageId === id}
                onSelect={onSelectMessage && id ? () => onSelectMessage(id) : undefined}
              />
            );
          })}
        </div>
      )}

      {draftMessages.length === 0 && (
        <MessageComposer
          task={task}
          conversationId={conversationId}
          onSent={() => void refetch()}
        />
      )}
    </div>
  );
}
