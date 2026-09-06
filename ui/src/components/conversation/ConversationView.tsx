import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Trans } from '@lingui/react/macro';
import { useLingui } from '@lingui/react/macro';
import { CheckCircle2, LifeBuoy, RefreshCw, RotateCcw } from 'lucide-react';
import {
  Agent,
  Conversation,
  DataSource,
  fetchConversations,
  FlowMessage,
  MessageThread,
  pickupConversation,
  settleTicket,
  QueryFilter,
  QueryRequest,
  TypeId,
  latestPointer,
} from '@sdk';
import { useAuth, useEntitiesQuery, useEntity, useOnTag, useProject } from '@sdk/react/hooks';
import type { ITask } from '@sdk/entities/task';
import { isClosedConversation, isHelpdeskKind } from '@sdk/entities/conversation';
import { isViewer } from './conversation-category';
import { ThreadStack } from './ThreadStack';
import { channelLabel, sourceForOrigin } from './channel-attribution';
import { sourcesQuery } from '@src/components/data-sources/use-source-specs';
import { useAttentionPolling } from '@src/components/data-sources/useAttentionPolling';
import { syncConversationMessages, updateMessage } from '@src/components/inbox-view/inbox-api';
import { FlowMessageKind, markFlowMessagesReceived } from '@sdk/entities/flow-message';
import { FlowMessageBubble } from './FlowMessageBubble';
import { SessionEventLine } from './SessionEventLine';
import { SessionCard } from './SessionCard';
import { MessageComposer } from './MessageComposer';
import { useImplementPlan } from './useImplementPlan';
import { useLocalUser } from './useLocalUser';
import { useMembers } from '@src/hooks/use-members';
import {
  buildConversationItems,
  groupThreadItems,
  itemThreadId,
  ConversationItemKind,
  anchorSessionItems,
  shouldShowSoloSendNotice,
  type ConversationItem,
} from './conversation-items';
import { resolveAttachmentProjectId } from './conversation-context-aggregation';
import { useConversationMessageAttachments } from './useMessageAttachments';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useProcessesForTarget } from '@src/components/entity-execution-panel/hooks/useProcessesForTarget';
import { mostRecentProcess } from '@src/utils/process-recency';
import { sessionRole, useConversationSessions } from '@src/hooks/useConversationSessions';

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
  /** Open an executed message's run in the drawer's Runs tab, focused on it.
   *  Fired by the per-message run-status one-liner (not by executing). */
  onOpenRun?: (processId: string) => void;
  /** URL-carried thread filter: show only this thread's messages, unpacked.
   *  Null = every thread, each packed into one row. */
  threadId?: string | null;
  /** Open a thread (id) or return to the packed list (null). URL-first — the
   *  view never filters itself, it asks the host to navigate. */
  onThreadNavigate?: (threadId: string | null) => void;
  /** Restrict this view and every mutation to one Agent's formal inbox. */
  agentId?: string | null;
}

/** Geometry shared by the ticket-header actions. Only the colour differs
 *  between them, so a padding or type-scale tweak belongs in one place. */
const ticketActionClassName =
  'flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] font-medium transition-colors disabled:opacity-50';

export function ConversationView({
  conversationId,
  task,
  ensureMapped,
  selectedMessageIds,
  onSelectMessage,
  onMostRecentMessageChange,
  onOpenRun,
  threadId,
  onThreadNavigate,
  agentId,
}: ConversationViewProps) {
  const { t } = useLingui();
  const conversationTypeId = useMemo(() => new TypeId(Conversation.type, conversationId), [conversationId]);
  const { data: conversation, refetch } = useEntity<Conversation>(conversationTypeId);
  const { localUser } = useLocalUser();

  // Resolve the conversation's headless run + its live status ONCE here, rather
  // than per bubble, and hand it to every executed message's run-status
  // one-liner. Load-bearing assumption: the backend reuses ONE run per
  // conversation (execute_prompt.py `_reuse_or_spawn_headless`), so the
  // most-recent run IS the run each executed message spawned. Same query key as
  // the Runs tab, so the two subscriptions dedup.
  const { processes: convRuns } = useProcessesForTarget(conversationTypeId.toString());
  const convRun = useMemo(() => mostRecentProcess(convRuns), [convRuns]);
  // The run entity carries live worker status now (headless turns broadcast
  // mid-turn), so read it directly instead of deriving over the stream.
  const convRunStatus = convRun?.workerStatus ?? null;

  // Every live session of this conversation, resolved ONCE and handed down:
  // the feed pins each to its opening message; each card reads its own row.
  const { byId: sessionsById, anchors: sessionAnchors } = useConversationSessions(conversationId);

  // Member roster used to resolve a message's hub-authoritative sender_id to
  // a display name. `useMembers` is the single precedence point: the live
  // entity-cache roster wins once populated (kept fresh by membership-change
  // fanout frames and list-refresh upserts), with the hook's one-shot hub
  // fetch as the initial-load source while the cache is cold.
  // `rosterReady` is true once the hub has answered for this conv at least
  // once (success or failure) — FlowMessageBubble uses it to gate the alert
  // glyph so legitimate load windows don't flash UNRESOLVED.
  const { members: memberRoster, ready: rosterReady, refresh: refreshMembers } = useMembers(conversationTypeId);
  const participants = memberRoster;

  const [agentScope, setAgentScope] = useState<Awaited<ReturnType<Agent['inboxScope']>> | null>(null);
  const refreshAgentScope = useCallback(async () => {
    if (!agentId) {
      setAgentScope(null);
      return;
    }
    try {
      setAgentScope(await new Agent({ id: agentId }).inboxScope());
    } catch {
      setAgentScope({ agent_id: agentId, source_id: null, conversation_ids: [], thread_ids: [], flow_message_ids: [] });
    }
  }, [agentId]);
  useEffect(() => void refreshAgentScope(), [conversation?.message_ids, refreshAgentScope]);
  const allowedMessageIds = useMemo(
    () => (agentId ? new Set(agentScope?.flow_message_ids ?? []) : null),
    [agentId, agentScope?.flow_message_ids],
  );
  const pointers = useMemo(
    () => (conversation?.conversationMessageIds ?? []).filter((pointer) => !allowedMessageIds || allowedMessageIds.has(pointer.id)),
    // conversationMessageIds is a parsed view over the message_ids JSON field.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [conversation?.message_ids, allowedMessageIds],
  );

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
  const messagesRequest = useMemo(
    () =>
      new QueryRequest({
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
      }),
    [conversationId],
  );
  const { data: conversationMessages = [], refetch: refetchConversationMessages } = useEntitiesQuery<FlowMessage>(messagesRequest, {
    enabled: !!conversationId,
  });
  const conversationMessagesKey = conversationMessages.map((message) => message.id).sort().join(',');
  useEffect(() => {
    if (!agentId || !conversationMessagesKey) return;
    // Source projection writes the FlowMessage and the conversation pointer in
    // one backend pass, but their live-query frames are independent. A new raw
    // message is therefore the reliable prompt to pull both the pointer list
    // and the Agent's formal source scope before rendering it.
    void Promise.all([refetch(), refreshAgentScope()]).catch(() => {
      // Keep the already-rendered thread during a transient refresh failure.
    });
  }, [agentId, conversationMessagesKey, refetch, refreshAgentScope]);
  const messagesById = useMemo(() => {
    const entries: Array<[string, FlowMessage]> = [];
    for (const message of conversationMessages) {
      if (message.id && (!allowedMessageIds || allowedMessageIds.has(message.id))) entries.push([message.id, message]);
    }
    return new Map(entries);
  }, [allowedMessageIds, conversationMessages]);

  // Pull this conversation's hub messages once per open (and whenever the
  // pointer set changes — a new reply landed). The backend syncs only the
  // new/changed messages in a single request (LWW by updated_date); the live
  // `messagesById` query above renders whatever lands, so no per-message
  // backfill loop or remount-keying is needed.
  useEffect(() => {
    if (!conversationId) return;
    void syncConversationMessages(conversationId, agentId ?? undefined).catch(() => {
      // Hub offline / not configured — the local query still renders what we
      // already have; avoid surfacing transient sync failures to the user.
    });
    // Re-sync when the pointer set changes so brand-new replies pull through.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, conversationId, pointers.map((p) => p.id).join(',')]);

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

  const orderedItems = useMemo(() => buildConversationItems(pointers, draftMessages), [pointers, draftMessages]);

  // The cloud thread this conversation caches, if any — the first message that
  // carries an `origin`. Every message in a source-backed conversation shares a
  // channel, so the first one found answers for the conversation.
  const channelOrigin = useMemo(() => {
    for (const fm of messagesById.values()) {
      if (fm.origin?.kind) return fm.origin;
    }
    return null;
  }, [messagesById]);

  // Attention-driven polling: while this source-backed conversation is the
  // SELECTED dock, keep its DataSource due (request_poll on an interval) so
  // new messages land fast; deselect and the requests stop on their own.
  // Source resolution is the SAME rule the attribution chip uses.
  const { data: attentionSources = [] } = useEntitiesQuery<DataSource>(sourcesQuery);
  const attentionSourceId = useMemo(() => {
    if (agentId) return agentScope?.source_id ?? undefined;
    const withPointer = [...messagesById.values()].find((fm) => fm.origin_local?.data_source_id);
    return sourceForOrigin(
      attentionSources, channelOrigin, withPointer?.origin_local ?? null,
    )?.id;
  }, [agentId, agentScope?.source_id, channelOrigin, messagesById, attentionSources]);
  useAttentionPolling(attentionSourceId, conversationId);

  // The ingest sync boundary is too early: inbox projection runs as a detached
  // subscriber and writes the FlowMessage + conversation pointer afterward.
  // Refresh on the existing post-projection event instead, scoped to this
  // Agent's DataSource so another active source cannot disturb this thread.
  useOnTag(
    'inbox.*.message.projected',
    () => {
      if (!agentId || !attentionSourceId) return;
      void Promise.all([
        refetch(),
        refetchConversationMessages(),
        refreshAgentScope(),
      ]).catch(() => {
        // Keep the already-rendered thread during a transient refresh failure.
      });
    },
    {
      scope: [attentionSourceId ? `data_source:${attentionSourceId}` : 'data_source:__inactive__'],
    },
  );

  // What is in flight. Local state, because the line must appear the instant
  // the user hits Send — the worker's process does not exist yet. Cleared when
  // the reply lands, which is the only honest signal it is no longer sending.
  const [sendingText, setSendingText] = useState<string | null>(null);

  useEffect(() => {
    if (sendingText) setSendingText(null);
    // Intentionally keyed on the pointer count alone: a new message in this
    // conversation IS the arrival, whichever direction it came from.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pointers.length]);

  // Authoritative per-thread sizes. The feed query is windowed, so counting
  // the loaded messages would undercount a long thread; MessageThread carries
  // the real number and this is the only reason the entity is fetched here.
  const threadsRequest = useMemo(
    () => new QueryRequest({
      type: MessageThread.type,
      name: `threads:${conversationId}`,
      query: new QueryFilter({
        match: { op: '$EQ', operands: ['conversation_id', conversationId] },
      }),
    }),
    [conversationId],
  );
  // Only the packed view reads these counts, so a thread-filtered view opens
  // no subscription at all.
  const { data: threads = [] } = useEntitiesQuery<MessageThread>(threadsRequest, {
    enabled: !!conversationId && !threadId,
  });
  const threadCounts = useMemo(
    () => new Map(threads.filter((th) => !agentId || agentScope?.thread_ids.includes(th.id ?? '')).map((th) => [th.id ?? '', th.message_count ?? 0])),
    [agentId, agentScope?.thread_ids, threads],
  );

  // Two views of one feed, chosen by the URL:
  //   ?thread=<id> → only that thread's messages, unpacked
  //   (absent)     → every thread packed into one row, internal chat flat
  //
  // Threaded and session messages are disjoint — an ingested email never has a
  // `remote_worker_session_id` — so each grouper gets its own slice. Session
  // messages collapse onto the message that opened the session (the anchor);
  // follow-ups, replies and lifecycle lines are hidden from the thread and
  // live in the session view.
  const groupedItems = useMemo(() => {
    const getFm = (id: string) => messagesById.get(id) ?? null;
    if (threadId) {
      const inThread = orderedItems.filter((it) => itemThreadId(it, getFm) === threadId);
      return anchorSessionItems(inThread, getFm, sessionAnchors);
    }
    const threaded: ConversationItem[] = [];
    const plain: ConversationItem[] = [];
    for (const item of orderedItems) {
      (itemThreadId(item, getFm) ? threaded : plain).push(item);
    }
    return [
      ...groupThreadItems(threaded, getFm, threadCounts),
      ...anchorSessionItems(plain, getFm, sessionAnchors),
    ].sort((a, b) => a.sortAt - b.sortAt);
  }, [orderedItems, messagesById, threadId, threadCounts, sessionAnchors]);

  // One row of the feed — a normal bubble or a draft bubble. A stray
  // kind=session_event row (a lifecycle line whose session the feed could not
  // anchor) renders as a slim centered system line.
  const renderConversationItem = (item: ConversationItem) => {
    if (item.kind === ConversationItemKind.POINTER) {
      const id = item.messageId;
      const fm = messagesById.get(id) ?? null;
      if (fm?.kind === FlowMessageKind.SESSION_EVENT) {
        return <SessionEventLine key={item.key} text={fm.text ?? ''} />;
      }
      // One plan session per conversation. Once any session exists (or
      // is in-flight) every spec-bearing bubble shows the "Open" link
      // pointing at the same session — and the chip is suppressed
      // everywhere so we never offer to spawn a duplicate.
      return (
        <FlowMessageBubble
          key={item.key}
          messageId={id}
          fm={fm}
          timestamp={item.timestamp}
          task={task}
          participants={participants}
          rosterReady={rosterReady}
          run={convRun}
          runStatus={convRunStatus}
          onOpenRun={onOpenRun}
          onImplementPlan={task && !openPlanSession ? runImplementPlan : undefined}
          onOpenPlanSession={openPlanSession}
          onViewPlan={runViewPlan}
          isSelected={(selectedMessageIds ?? []).includes(id)}
          onSelect={onSelectMessage ? () => onSelectMessage(id) : undefined}
          isConversationOwner={isConversationOwner}
          onDeleteMessage={handleDeleteMessage}
          isHelpdesk={isHelpdeskConversation}
          viewerCloudUserId={cloudUserId}
          attachmentProjectId={attachmentProjectId}
          messageAttachments={attachmentsByMessage.get(id)}
          showEmailHeaders={!!agentId}
        />
      );
    }
    const id = item.draft.id ?? '';
    return (
      <FlowMessageBubble
        key={item.key}
        messageId={id}
        fm={item.draft}
        timestamp={
          item.draft.created_date instanceof Date
            ? item.draft.created_date.toISOString()
            : (item.draft.created_date ?? '')
        }
        task={task}
        participants={participants}
        rosterReady={rosterReady}
        isDraft
        onDraftSent={() => void refetch()}
        isSelected={!!id && (selectedMessageIds ?? []).includes(id)}
        onSelect={onSelectMessage && id ? () => onSelectMessage(id) : undefined}
        attachmentProjectId={attachmentProjectId}
      />
    );
  };

  // "You're the only participant" notice — computed, never persisted. Shown
  // under the last message when the local user sends into a shared
  // conversation whose roster has shrunk to just them (everyone else left),
  // so they know nobody will see it. See shouldShowSoloSendNotice.
  const lastItem = orderedItems.length > 0 ? orderedItems[orderedItems.length - 1] : null;
  const lastMessageSenderId =
    lastItem?.kind === ConversationItemKind.POINTER ? (messagesById.get(lastItem.messageId)?.sender_id ?? null) : null;

  // Surface the most-recent message id so the parent's Context tab can default
  // to it when the user hasn't clicked anything yet.
  const mostRecentMessageId = useMemo<string | null>(() => {
    for (let i = orderedItems.length - 1; i >= 0; i--) {
      const item = orderedItems[i];
      const id = item.kind === ConversationItemKind.POINTER ? item.messageId : (item.draft.id ?? null);
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
    const el = document.querySelector<HTMLElement>(`[data-testid="message-bubble-${CSS.escape(target)}"]`);
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
    const candidates = pointers.map((p) => p.id).filter((id) => id && !ackedRef.current.has(id));
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

  // Help-desk (support) ticket: replies are masked to a single brand
  // identity, and the real responder's sender_id is intentionally absent from
  // the guest's (redacted) roster — so the bubble must not flag it as an
  // unknown sender. See HelpdeskConfig / the hub sender_name masking.
  const isHelpdeskConversation = isHelpdeskKind(conversation?.kind);
  const { project: currentProject } = useProject();
  const attachmentProjectId = resolveAttachmentProjectId(task, conversation, currentProject?.id);
  // Staged bundle attachments (one query for the whole panel). Drives the
  // dashed staged chips + review modal in each bubble.
  const { byMessage: attachmentsByMessage } = useConversationMessageAttachments(conversationId);

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
      (participants ?? []).some((p) => p.user_id === cloudUserId && (p.role ?? '').toLowerCase() === 'owner'));

  // Open-to-read (URL-first): viewing a conversation marks its latest received
  // message read — the mutation lives HERE, on the mounted view, so the Inbox
  // row click / banner click / direct link only navigate (single writer:
  // navigation → view → action; the backend then reconciles
  // InboxManager.unread). Focus-gated: a message arriving while the window is
  // backgrounded must stay unread (it drives the badge) until the user
  // actually returns — hence the re-run on window focus.
  const readMarkedRef = useRef<string | null>(null);
  useEffect(() => {
    const markLatestRead = () => {
      if (!document.hasFocus()) return;
      const latestId = latestPointer(pointers)?.id;
      const latest = latestId ? messagesById.get(latestId) : undefined;
      if (!latest?.id || latest.is_read) return;
      if (isViewer(latest.sender_id, { email: '', cloudUserId, localUserId: localUser?.id ?? null })) return;
      const key = `${conversationId}:${latest.id}`;
      if (readMarkedRef.current === key) return;
      readMarkedRef.current = key;
      void updateMessage(latest.id, { is_read: true }, agentId ?? undefined).catch(() => {
        readMarkedRef.current = null; // transient failure — retry on next tick/focus
      });
    };
    markLatestRead();
    window.addEventListener('focus', markLatestRead);
    return () => window.removeEventListener('focus', markLatestRead);
  }, [agentId, conversationId, pointers, messagesById, cloudUserId, localUser?.id]);

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
      await Promise.allSettled([fetchConversations(agentId ?? undefined), syncConversationMessages(conversationId, agentId ?? undefined), refreshMembers()]);
      await refetch();
    } finally {
      setHubSyncing(false);
    }
  }, [agentId, refetch, refreshMembers, conversationId]);

  // Staff "pick up" affordance for a helpdesk ticket: shown only on a
  // helpdesk conversation the local cloud user hasn't joined and didn't open
  // (the guest initiator is the owner). Joining adds them to the roster so they
  // receive messages and can reply. See pickupConversation / hub Conversation.pickup.
  const [pickingUp, setPickingUp] = useState(false);
  const isParticipant = !!cloudUserId && (participants ?? []).some((p) => p.user_id === cloudUserId);
  const canPickup = isHelpdeskConversation && !!cloudUserId && !isConversationOwner && !isParticipant;

  const showSoloNotice = shouldShowSoloSendNotice({
    remote: conversation?.remote === true,
    helpdesk: isHelpdeskConversation,
    rosterReady,
    participants: participants ?? [],
    cloudUserId,
    lastItem,
    lastMessageSenderId,
  });
  // The other participant of a 1:1 shared conversation is the HOST every
  // prompt runs on. The peer's user_id must be RESOLVED (an unresolved roster
  // row passes the filter with user_id null) before the composer offers to
  // run there.
  const otherParticipant = useMemo(
    () => (participants ?? []).find((p) => p.user_id !== cloudUserId) ?? null,
    [participants, cloudUserId],
  );
  const sessionHost = useMemo(
    () =>
      conversation?.remote === true && rosterReady && (participants ?? []).length === 2 && !!cloudUserId && !!otherParticipant?.user_id
        ? { userId: otherParticipant.user_id, name: otherParticipant.name ?? otherParticipant.email ?? null }
        : null,
    [conversation?.remote, rosterReady, participants, cloudUserId, otherParticipant],
  );
  const openLiveSession = useCallback(
    (sessionId: string) => {
      dockNavigation.openDock(DockPointer.forLiveSession(sessionId));
    },
    [dockNavigation],
  );

  // Affordance only — the hub's `_set_settlement` is the authority on who may
  // settle. Mirrors `canPickup` below. Note this is NARROWER than the server
  // rule: desk staff triaging from the queue who have not picked the ticket up
  // see no button until they do.
  const [settling, setSettling] = useState(false);
  const isClosed = isClosedConversation(conversation?.status);
  const canSettle = isHelpdeskConversation && (isConversationOwner || isParticipant);

  const handleSettle = useCallback(async () => {
    setSettling(true);
    try {
      await settleTicket(conversationId, isClosed ? 'reopen' : 'close');
      await handleRefresh();
    } catch (err) {
      console.error('[conversation] settle failed', conversationId, err);
    } finally {
      setSettling(false);
    }
  }, [conversationId, isClosed, handleRefresh]);

  const handlePickup = useCallback(async () => {
    setPickingUp(true);
    try {
      await pickupConversation(conversationId);
      await handleRefresh();
    } catch (err) {
      console.error('[conversation] pickup failed', conversationId, err);
    } finally {
      setPickingUp(false);
    }
  }, [conversationId, handleRefresh]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end gap-1">
        {canPickup && (
          <button
            type="button"
            onClick={() => void handlePickup()}
            disabled={pickingUp}
            title={t`Join this support ticket so you can reply`}
            data-testid="pickup-conversation-button"
            className={`${ticketActionClassName} border-violet-500/40 bg-violet-500/15 text-violet-600 hover:bg-violet-500/25 dark:text-violet-400`}
          >
            <LifeBuoy className="h-3 w-3" />
            {pickingUp ? <Trans>Picking up…</Trans> : <Trans>Pick up</Trans>}
          </button>
        )}
        {canSettle && (
          <button
            type="button"
            onClick={() => void handleSettle()}
            disabled={settling}
            title={isClosed ? t`Reopen this ticket` : t`Mark this ticket answered and take it off the desk's queue`}
            data-testid="settle-conversation-button"
            className={`${ticketActionClassName} border-border text-muted-foreground hover:bg-muted hover:text-foreground`}
          >
            {isClosed ? <RotateCcw className="h-3 w-3" /> : <CheckCircle2 className="h-3 w-3" />}
            {settling ? <Trans>Saving…</Trans> : isClosed ? <Trans>Reopen</Trans> : <Trans>Close ticket</Trans>}
          </button>
        )}
        <button
          type="button"
          onClick={() => void handleRefresh()}
          title={t`Refresh (pulls from hub)`}
          data-testid="refresh-conversation-button"
          className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${hubSyncing ? 'animate-spin' : ''}`} />
        </button>
      </div>
      {orderedItems.length === 0 ? (
        <p className="text-xs italic text-muted-foreground/60">
          <Trans>No messages yet.</Trans>
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {groupedItems.map((item) => {
            if (item.kind === ConversationItemKind.THREAD_GROUP) {
              return (
                <ThreadStack
                  key={item.key}
                  messageCount={item.messageCount}
                  onOpenThread={onThreadNavigate ? () => onThreadNavigate(item.threadId) : undefined}
                >
                  {renderConversationItem(item.head)}
                </ThreadStack>
              );
            }
            if (item.kind === ConversationItemKind.SESSION_ANCHOR) {
              const session = sessionsById.get(item.sessionId) ?? null;
              const role = sessionRole(session, cloudUserId);
              return (
                <div key={item.key} className="flex flex-col gap-1" data-testid="session-anchor">
                  {renderConversationItem(item.anchor)}
                  <SessionCard
                    sessionId={item.sessionId}
                    session={session}
                    role={role}
                    promptCount={item.promptCount}
                    replyCount={item.replyCount}
                    onOpen={() => openLiveSession(item.sessionId)}
                    onApprove={role === 'host' && session ? () => session.approve() : undefined}
                    onDecline={role === 'host' && session ? () => session.decline() : undefined}
                  />
                </div>
              );
            }
            return renderConversationItem(item);
          })}
        </div>
      )}

      {showSoloNotice && (
        <p data-testid="solo-participant-notice" className="text-[11px] italic text-muted-foreground/70">
          <Trans>You're the only participant in this conversation — no one else will see this message.</Trans>
        </p>
      )}

      {/* Always render the reply composer. A pending draft (e.g. an "Approve &
          Execute" auto-reply awaiting review) renders above as its own editable
          bubble with Send/Discard — but it must not block composing a fresh reply.
          The plain composer never auto-creates a draft, so there's no duplication
          loop. */}
      {/* Deliberately does NOT name the outcome. Whether a reply is delivered
          or parked as a draft is the transport's business — Agentmail sends,
          the Gmail connector can only draft — and the composer learns which
          only when the send resolves. Copy that promised "drafted" was simply
          wrong half the time. The reply itself arrives in the feed by the
          ordinary ingest route once it exists. */}
      {sendingText && (
        <SessionEventLine
          text={t`Sending in ${channelLabel(channelOrigin?.kind)}: “${sendingText}”`}
        />
      )}
      <MessageComposer
        conversationId={conversationId}
        onSent={() => void refetch()}
        // A source-backed conversation replies into its channel, not the hub.
        channel={channelOrigin?.kind}
        onChannelSent={setSendingText}
        placeholder={channelOrigin ? t`Reply in ${channelLabel(channelOrigin.kind)}` : undefined}
        agentId={agentId ?? undefined}
        sessionHost={channelOrigin ? null : sessionHost}
      />
    </div>
  );
}
