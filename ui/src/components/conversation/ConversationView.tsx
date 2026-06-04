import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import {
  Conversation,
  dataManager,
 fetchConversations, FlowMessage,
  QueryFilter,
  QueryRequest,

  TypeId,
} from '@sdk';
import { useAuth, useEntitiesQuery, useEntity } from '@sdk/react/hooks';
import type { ITask } from '@sdk/entities/task';
import { syncConversationMessages } from '@src/components/inbox-view/inbox-api';
import { markFlowMessagesReceived } from '@sdk/entities/flow-message';
import { FlowMessageBubble } from './FlowMessageBubble';
import { MessageComposer } from './MessageComposer';
import { useApproveAndExecute } from './useApproveAndExecute';
import { useImplementPlan } from './useImplementPlan';
import { useLocalUser } from './useLocalUser';
import { useMembers } from '@src/hooks/use-members';
import { buildConversationItems, ConversationItemKind } from './conversation-items';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';

// Cap the initial messages window so long conversations don't fetch + watch
// every FlowMessage they've ever held. Newest-first so the visible window is
// always at the bottom of the conversation; older messages load on demand.
const CONVERSATION_MESSAGES_WINDOW = 500;

interface ConversationViewProps {
  conversationId: string;
  /** Optional. Task-bound conversations (inbound .flowmsg) pass it; project-scoped do not. */
  task?: ITask | null;
  senderName?: string;
  /** Wraps any action that needs a `cwd`/project. Provided by the parent (SharedTaskView / TaskDetailPanel). */
  ensureMapped?: (continuation: () => void | Promise<void>) => void;
  /** Currently-selected message ids. Multiple entries when the selection
   *  came from clicking a context entity that's attached to more than one
   *  message — every one of those bubbles should light up together. */
  selectedMessageIds?: readonly string[];
  /** Called when the user clicks (or starts editing) a single message. The
   *  parent typically collapses the selection to just this bubble. */
  onSelectMessage?: (messageId: string) => void;
  /** Reports the most recent message id so the parent can default-select it. */
  onMostRecentMessageChange?: (messageId: string | null) => void;
  /** Fired the instant the user clicks Approve & Execute, so the parent can
   *  surface the spawned run (e.g. pop the Runs drawer tab). The action
   *  itself is async — this just announces the click. */
  onApproveAndExecuteFired?: () => void;
}

export function ConversationView({
  conversationId,
  task,
  senderName: _senderName,
  ensureMapped,
  selectedMessageIds,
  onSelectMessage,
  onMostRecentMessageChange,
  onApproveAndExecuteFired,
}: ConversationViewProps) {
  const conversationTypeId = useMemo(
    () => new TypeId(Conversation.type, conversationId),
    [conversationId],
  );
  const { data: conversation, refetch } = useEntity<Conversation>(conversationTypeId);
  const { localUser } = useLocalUser();

  // Member roster used to resolve a message's hub-authoritative sender_id to
  // a display name. Precedence is `conversation.participants` (entity-cache,
  // updated via the live-query whenever the hub pushes a change) FIRST, with
  // the explicit hub fetch in `useMembers` as the initial-load source while
  // the entity cache is still cold. This keeps post-kick/role-change updates
  // visible immediately (the entity update fires before the next user-driven
  // refresh) while still getting a populated roster on first paint.
  // `rosterReady` is true once the hub has answered for this conv at least
  // once (success or failure) — FlowMessageBubble uses it to gate the alert
  // glyph so legitimate load windows don't flash UNRESOLVED.
  const { members: memberRoster, ready: rosterReady, refresh: refreshMembers } = useMembers(conversationTypeId);
  const participants = useMemo(
    () =>
      conversation?.participants && conversation.participants.length > 0
        ? conversation.participants
        : memberRoster,
    [conversation?.participants, memberRoster],
  );

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

  // All FlowMessages in this conversation, fetched in ONE live query (replaces
  // the per-bubble `useEntity` N+1). The query is the source of truth for
  // message bodies; the conversation's pointer list still drives order. Match
  // is wrapped in $AND for the same reason as the drafts query (the SDK's
  // plain-object shorthand doesn't recursively wrap operands). Capped at
  // CONVERSATION_MESSAGES_WINDOW newest rows so long-running conversations
  // don't fetch + watch O(total) entities on every open; older messages
  // load on demand via a `created_date $LT` cursor extension here.
  const messagesRequest = useMemo(() => new QueryRequest({
    type: FlowMessage.type,
    scope: [],
    name: `messages:${conversationId}`,
    query: new QueryFilter({
      match: {
        op: '$AND',
        operands: [{ op: '$EQ', operands: ['conversation_id', conversationId] }],
      } as Record<string, unknown>,
      limit: CONVERSATION_MESSAGES_WINDOW,
      order_by: { created_date: 'desc' },
    }),
  }), [conversationId]);
  const { data: conversationMessages = [] } = useEntitiesQuery<FlowMessage>(messagesRequest, {
    enabled: !!conversationId,
  });
  const messagesById = useMemo(
    () => new Map(conversationMessages.filter((m) => m.id).map((m) => [m.id as string, m])),
    [conversationMessages],
  );

  // Pull this conversation's hub messages once per open (and whenever the
  // pointer set changes — a new reply landed). The backend syncs only the
  // new/changed messages in a single request (LWW by updated_date); the live
  // `messagesById` query above renders whatever lands, so no per-message
  // backfill loop or remount-keying is needed.
  useEffect(() => {
    if (!conversationId) return;
    void syncConversationMessages(conversationId).catch(() => {
      // Hub offline / not configured — the local query still renders what we
      // already have; avoid surfacing transient sync failures to the user.
    });
    // Re-sync when the pointer set changes so brand-new replies pull through.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, pointers.map((p) => p.id).join(',')]);

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
      // Surface the spawned run right away — `approveAndExecute` is async (the
      // spawn + capture-turn round-trip takes hundreds of ms), so calling the
      // reveal-runs callback at click time, not after the await, gives the
      // user immediate feedback that the drawer flipped to the Runs tab.
      onApproveAndExecuteFired?.();
      const action = async () => {
        await approveAndExecute(messageId, idx);
        void refetch();
      };
      if (ensureMapped) ensureMapped(action);
      else void action();
    },
    [approveAndExecute, refetch, ensureMapped, canApproveAndExecute, onApproveAndExecuteFired],
  );

  // Implement Plan lifecycle — spawn + watch + open. See `useImplementPlan.ts`
  // for the full lifecycle docs. The hook returns `runImplementPlan` to wire
  // into each bubble's chip and a single `openPlanSession` that flips every
  // spec-bearing bubble to the "Open Plan Implementation Session" link the
  // instant any session in the thread exists (live or in-flight).
  const { runImplementPlan, openPlanSession } = useImplementPlan({
    task,
    conversationId,
    pointers,
    ensureMapped,
  });

  // View Plan opens the spec's `.md` in the Milkdown dock — read-write,
  // same target the Shared Context "View" spec row navigates to.
  // `MessageBubble` does the spec-TypeId lookup per bubble and invokes this
  // with the spec id.
  const { navigation: dockNavigation } = useDockNavigation();
  const runViewPlan = useCallback(
    (specId: string) => {
      dockNavigation.openDock(DockPointer.forSpec(specId));
    },
    [dockNavigation],
  );

  const orderedItems = useMemo(
    () => buildConversationItems(pointers, draftMessages),
    [pointers, draftMessages],
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

  // Pull the (earliest) selected message into view whenever the selection
  // changes. `block: nearest` makes this a no-op when the bubble is already
  // on screen, so single-bubble clicks don't yank the scroll. Cross-message
  // selections (entity click → N origins) scroll to the first one in
  // conversation order — same id every render, so we still only scroll on
  // genuine selection changes. The "set" identity is compared via the joined
  // string so a re-render of the same array doesn't re-fire.
  //
  // Two-phase (arm → fire) so URL deep links (/conversation/<id>/message/<id>)
  // work: on a cold load the selection lands before the bubbles have rendered
  // (messages stream in via the live query), so a single same-tick
  // querySelector would miss. The pending id stays armed until the target
  // exists in the DOM — the fire effect re-runs as messages/items land.
  const selectionKey = (selectedMessageIds ?? []).join(',');
  const scrollTargetId = (selectedMessageIds ?? [])[0] ?? null;
  const pendingScrollIdRef = useRef<string | null>(null);
  const prevSelectionKeyRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const prev = prevSelectionKeyRef.current;
    prevSelectionKeyRef.current = selectionKey;
    if (prev === selectionKey) return; // re-render of the same selection
    pendingScrollIdRef.current = scrollTargetId;
  }, [selectionKey, scrollTargetId]);
  useEffect(() => {
    const target = pendingScrollIdRef.current;
    if (!target) return;
    const el = document.querySelector<HTMLElement>(
      `[data-testid="message-bubble-${CSS.escape(target)}"]`,
    );
    if (!el) return; // bubble not rendered yet — retry on the next data tick
    pendingScrollIdRef.current = null;
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [selectionKey, orderedItems, messagesById]);

  // Read-ack emission: when the conversation panel is open, batch-mark all
  // current pointers as `received`. The hub honors monotonicity + sender-skip
  // server-side, so re-acking already-received or own-sent messages is a
  // cheap no-op. Debounced 250ms to coalesce bursts (e.g. catch-up).
  const ackedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (pointers.length === 0) return;
    const candidates = pointers
      .map((p) => p.id)
      .filter((id) => id && !ackedRef.current.has(id));
    if (candidates.length === 0) return;
    const handle = setTimeout(() => {
      candidates.forEach((id) => ackedRef.current.add(id));
      void markFlowMessagesReceived(candidates).catch(() => {
        // Network/hub failure shouldn't crash the UI. Reset our tracker so
        // the next pointer change will retry.
        candidates.forEach((id) => ackedRef.current.delete(id));
      });
    }, 250);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pointers.map((p) => p.id).join(',')]);

  const conversationStatusVisible = conversation?.message_status_visible !== false;

  // The conversation owner (created_by == the local cloud user) may delete ANY
  // message; everyone may delete their own. The per-bubble sender check is done
  // inside FlowMessageBubble — this only supplies the owner half of the gate.
  const { cloudUser } = useAuth();
  const cloudUserId = cloudUser?.id ?? null;
  // Owner = either created_by matches (recipient side, where the hub stamped the
  // cloud-user id) OR the local user holds role "owner" in the participant
  // roster (creator side, where created_by is the local user id). The roster is
  // the hub-authoritative signal on both sides.
  const isConversationOwner =
    !!cloudUserId &&
    ((!!conversation?.created_by && conversation.created_by === cloudUserId) ||
      (participants ?? []).some(
        (p) => p.user_id === cloudUserId && (p.role ?? '').toLowerCase() === 'owner',
      ));

  // Delete a message everywhere. The loader/live-query owns the list, so we
  // only fire the SDK action and let the resulting data-op re-render the view
  // (no optimistic list mutation — URL/loader-first).
  const handleDeleteMessage = useCallback((messageId: string) => {
    void new FlowMessage({ id: messageId }).remove().catch((err) => {
      console.error('[conversation] delete message failed', messageId, err);
    });
  }, []);

  const [hubSyncing, setHubSyncing] = useState(false);
  // Full reload: messages AND members. The button is the user's explicit
  // "pull everything fresh from the hub" — so it force-reloads the roster
  // (refreshMembers re-fetches, bypassing the per-instance members cache),
  // re-syncs this conversation's messages, and re-reads the conversation
  // entity. Each leg is independent + best-effort so one offline hop doesn't
  // block the others.
  const handleRefresh = useCallback(async () => {
    setHubSyncing(true);
    try {
      await Promise.allSettled([
        fetchConversations(),
        syncConversationMessages(conversationId),
        refreshMembers(),
      ]);
      await refetch();
    } finally {
      setHubSyncing(false);
    }
  }, [refetch, refreshMembers, conversationId]);

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
              // One plan session per conversation. Once any session exists (or
              // is in-flight) every spec-bearing bubble shows the "Open" link
              // pointing at the same session — and the chip is suppressed
              // everywhere so we never offer to spawn a duplicate.
              return (
                <FlowMessageBubble
                  key={item.key}
                  messageId={id}
                  fm={messagesById.get(id) ?? null}
                  timestamp={item.timestamp}
                  task={task}
                  participants={participants}
                  rosterReady={rosterReady}
                  onApproveAndExecute={canApproveAndExecute ? runApprove : undefined}
                  onImplementPlan={task && !openPlanSession ? runImplementPlan : undefined}
                  onOpenPlanSession={openPlanSession}
                  onViewPlan={runViewPlan}
                  isSelected={(selectedMessageIds ?? []).includes(id)}
                  onSelect={onSelectMessage ? () => onSelectMessage(id) : undefined}
                  isConversationOwner={isConversationOwner}
                  onDeleteMessage={handleDeleteMessage}
                  conversationStatusVisible={conversationStatusVisible}
                  ensureProjectMapped={ensureMapped}
                />
              );
            }
            const id = item.draft.id ?? '';
            return (
              <FlowMessageBubble
                key={item.key}
                messageId={id}
                fm={item.draft}
                timestamp={item.draft.created_date instanceof Date
                  ? item.draft.created_date.toISOString()
                  : (item.draft.created_date ?? '')}
                task={task}
                participants={participants}
                rosterReady={rosterReady}
                isDraft
                onDraftSent={() => void refetch()}
                isSelected={!!id && (selectedMessageIds ?? []).includes(id)}
                onSelect={onSelectMessage && id ? () => onSelectMessage(id) : undefined}
                conversationStatusVisible={conversationStatusVisible}
              />
            );
          })}
        </div>
      )}

      {draftMessages.length === 0 && (
        <MessageComposer
          conversationId={conversationId}
          onSent={() => void refetch()}
        />
      )}
    </div>
  );
}
