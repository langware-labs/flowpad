import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Trans } from '@lingui/react/macro';
import { useLingui } from '@lingui/react/macro';
import { LifeBuoy, Radio, RefreshCw } from 'lucide-react';
import {
  Conversation,
  fetchConversations,
  FlowMessage,
  pickupConversation,
  QueryFilter,
  QueryRequest,
  RemoteWorkerSession,
  RemoteWorkerSessionStatus,
  TypeId,
} from '@sdk';
import { useAuth, useEntitiesQuery, useEntity, useProject } from '@sdk/react/hooks';
import type { ITask } from '@sdk/entities/task';
import { isHelpdeskKind } from '@sdk/entities/conversation';
import { syncConversationMessages, updateMessage } from '@src/components/inbox-view/inbox-api';
import { FlowMessageKind, markFlowMessagesReceived } from '@sdk/entities/flow-message';
import { FlowMessageBubble } from './FlowMessageBubble';
import { LiveSessionGroup, SessionEventLine } from './LiveSessionGroup';
import { MessageComposer } from './MessageComposer';
import { useApproveAndExecute } from './useApproveAndExecute';
import { ExecutePromptDialog } from './ExecutePromptDialog';
import { useImplementPlan } from './useImplementPlan';
import { useLocalUser } from './useLocalUser';
import { useMembers } from '@src/hooks/use-members';
import {
  buildConversationItems,
  ConversationItemKind,
  groupConversationItems,
  shouldShowSoloSendNotice,
  type ConversationItem,
} from './conversation-items';
import { resolveAttachmentProjectId } from './conversation-context-aggregation';
import { useConversationMessageAttachments } from './useMessageAttachments';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useProcessesForTarget } from '@src/components/entity-execution-panel/hooks/useProcessesForTarget';
import { mostRecentProcess } from '@src/utils/process-recency';
import { useRemoteWorkerSessionForConversation } from '@src/hooks/useRemoteWorkerSessionForConversation';

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
}

export function ConversationView({
  conversationId,
  task,
  ensureMapped,
  selectedMessageIds,
  onSelectMessage,
  onMostRecentMessageChange,
  onOpenRun,
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

  // Resolve the conversation's worker session ONCE (the RemoteWorkerSession the
  // backend binds on execute). Drives the session-aware run chip ("Run" vs
  // "<Host>'s session · new run") and the open-worker-session icon.
  const workerSession = useRemoteWorkerSessionForConversation(conversationId);

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

  const pointers = useMemo(
    () => conversation?.conversationMessageIds ?? [],
    // conversationMessageIds is a parsed view over the message_ids JSON field.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [conversation?.message_ids],
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
  const { data: conversationMessages = [] } = useEntitiesQuery<FlowMessage>(messagesRequest, {
    enabled: !!conversationId,
  });
  const messagesById = useMemo(() => {
    const entries: Array<[string, FlowMessage]> = [];
    for (const message of conversationMessages) {
      if (message.id) entries.push([message.id, message]);
    }
    return new Map(entries);
  }, [conversationMessages]);

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

  // Execute is backend-owned now; the hook is just the trigger.
  const { executePrompt } = useApproveAndExecute();

  const canApproveAndExecute = !!task || !!conversationId;

  // The Execute CTA opens a confirm dialog (run now + persist per-contact
  // permissions); this holds the message + sender + project it targets.
  const [executeTarget, setExecuteTarget] = useState<{
    messageId: string;
    contact: { userId?: string | null; email?: string | null; name?: string | null };
    projectId: string | null;
  } | null>(null);

  const runApprove = useCallback(
    (messageId: string) => {
      if (!canApproveAndExecute) return;
      const fm = messagesById.get(messageId);
      const senderId = fm?.sender_id ?? null;
      const sender = senderId ? participants.find((p) => p.user_id === senderId) : undefined;
      setExecuteTarget({
        messageId,
        contact: {
          userId: senderId,
          email: sender?.email ?? null,
          name: sender?.name ?? null,
        },
        projectId: conversation?.project_id ?? null,
      });
    },
    [canApproveAndExecute, messagesById, participants, conversation?.project_id],
  );

  const runExecute = useCallback(
    (messageId: string, autoReply: boolean) => {
      // No drawer pop on execute — the per-message run-status one-liner surfaces
      // the spawned run in place; the drawer opens only when the user clicks it.
      const action = async () => {
        await executePrompt(messageId, { autoReply });
        void refetch();
      };
      if (ensureMapped) ensureMapped(action);
      else void action();
    },
    [executePrompt, refetch, ensureMapped],
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

  // Open the conversation's worker session in its collaboration room view
  // (SharedSessionView). No-op unless the session has a mapped project + room.
  const { projectId: wsProjectId, roomId: wsRoomId, sessionId: wsSessionId } = workerSession;
  const openWorkerSession = useCallback(() => {
    if (!wsProjectId || !wsRoomId || !wsSessionId) return;
    dockNavigation.openProject(wsProjectId, { roomId: wsRoomId, sessionId: wsSessionId });
  }, [wsProjectId, wsRoomId, wsSessionId, dockNavigation]);

  const orderedItems = useMemo(() => buildConversationItems(pointers, draftMessages), [pointers, draftMessages]);

  // Consecutive live-session runs collapse into indented SESSION_GROUP rows
  // (keyed by fm.remote_worker_session_id). Bodies come from the live query —
  // messages outside the query window degrade to flat rendering.
  const groupedItems = useMemo(
    () => groupConversationItems(orderedItems, (id) => messagesById.get(id) ?? null),
    [orderedItems, messagesById],
  );

  // One row of the feed — a normal bubble, a draft bubble, or (for
  // kind=session_event messages) a slim centered system line. Shared by the
  // flat feed and the children of a LiveSessionGroup.
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
          onApproveAndExecute={canApproveAndExecute ? runApprove : undefined}
          run={convRun}
          runStatus={convRunStatus}
          onOpenRun={onOpenRun}
          workerSessionExists={workerSession.exists}
          workerSessionLabel={workerSession.label}
          workerSessionInFlight={workerSession.inFlight}
          onOpenWorkerSession={workerSession.exists ? openWorkerSession : undefined}
          onImplementPlan={task && !openPlanSession ? runImplementPlan : undefined}
          onOpenPlanSession={openPlanSession}
          onViewPlan={runViewPlan}
          isSelected={(selectedMessageIds ?? []).includes(id)}
          onSelect={onSelectMessage ? () => onSelectMessage(id) : undefined}
          isConversationOwner={isConversationOwner}
          onDeleteMessage={handleDeleteMessage}
          isHelpdesk={isHelpdeskConversation}
          attachmentProjectId={attachmentProjectId}
          messageAttachments={attachmentsByMessage.get(id)}
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
      const latestId = pointers[pointers.length - 1]?.id;
      const latest = latestId ? messagesById.get(latestId) : undefined;
      if (!latest?.id || latest.is_read) return;
      const senderId = latest.sender_id ?? null;
      if (senderId && (senderId === cloudUserId || senderId === localUser?.id)) return;
      const key = `${conversationId}:${latest.id}`;
      if (readMarkedRef.current === key) return;
      readMarkedRef.current = key;
      void updateMessage(latest.id, { is_read: true }).catch(() => {
        readMarkedRef.current = null; // transient failure — retry on next tick/focus
      });
    };
    markLatestRead();
    window.addEventListener('focus', markLatestRead);
    return () => window.removeEventListener('focus', markLatestRead);
  }, [conversationId, pointers, messagesById, cloudUserId, localUser?.id]);

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
      await Promise.allSettled([fetchConversations(), syncConversationMessages(conversationId), refreshMembers()]);
      await refetch();
    } finally {
      setHubSyncing(false);
    }
  }, [refetch, refreshMembers, conversationId]);

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
  // ── Start live session ────────────────────────────────────────────────
  // 1:1 conversations only (v1): the OTHER participant is the host. The click
  // mints the session id locally (uuid4 — validate-on-adopt backend-side),
  // saves a guest-local DRAFT row, and ONLY navigates (URL-first: the live-
  // session loader/view own everything else). Disabled while a non-terminal
  // session already exists or in multi-party rosters.
  const otherParticipant = useMemo(
    () => (participants ?? []).find((p) => p.user_id !== cloudUserId) ?? null,
    [participants, cloudUserId],
  );
  const canStartLiveSession =
    conversation?.remote === true &&
    rosterReady &&
    (participants ?? []).length === 2 &&
    !!cloudUserId &&
    // The peer's user_id must be RESOLVED, not just the participant row
    // present: an unresolved roster row (user_id null) passes the
    // `p.user_id !== cloudUserId` filter and would mint a session draft with
    // host_user_id=null — the host then materializes a row without its own
    // identity and never shows the Approve bar (see apply_snapshot heal).
    !!otherParticipant?.user_id &&
    !workerSession.hasLiveSession;
  const liveSessionDisabledReason = !conversation?.remote
    ? t`Live sessions need a shared conversation`
    : (participants ?? []).length !== 2
      ? t`Live sessions are 1:1 — available in two-person conversations`
      : workerSession.hasLiveSession
        ? t`A live session is already running in this conversation`
        : otherParticipant && !otherParticipant.user_id
          ? t`Waiting for the other participant's identity to sync…`
          : null;
  const [startingSession, setStartingSession] = useState(false);
  const handleStartLiveSession = useCallback(async () => {
    if (!canStartLiveSession || startingSession) return;
    setStartingSession(true);
    try {
      const sessionId = crypto.randomUUID();
      const draft = new RemoteWorkerSession({
        id: sessionId,
        conversation_id: conversationId,
        status: RemoteWorkerSessionStatus.DRAFT,
        guest_user_id: cloudUserId,
        guest_name: cloudUser?.name ?? cloudUser?.email ?? null,
        host_user_id: otherParticipant?.user_id ?? null,
        host_name: otherParticipant?.name ?? otherParticipant?.email ?? null,
      });
      await draft.save();
      dockNavigation.openDock(DockPointer.forLiveSession(sessionId));
    } catch (err) {
      console.error('[conversation] start live session failed', err);
    } finally {
      setStartingSession(false);
    }
  }, [
    canStartLiveSession,
    startingSession,
    conversationId,
    cloudUserId,
    cloudUser,
    otherParticipant,
    dockNavigation,
  ]);
  const openLiveSession = useCallback(
    (sessionId: string) => {
      dockNavigation.openDock(DockPointer.forLiveSession(sessionId));
    },
    [dockNavigation],
  );

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
        {(conversation?.remote === true || workerSession.hasLiveSession) && (
          <button
            type="button"
            onClick={() =>
              workerSession.hasLiveSession && workerSession.sessionId
                ? openLiveSession(workerSession.sessionId)
                : void handleStartLiveSession()
            }
            disabled={!canStartLiveSession && !workerSession.hasLiveSession}
            title={
              workerSession.hasLiveSession
                ? t`Open the live session`
                : (liveSessionDisabledReason ?? t`Work on the other participant's machine`)
            }
            data-testid="start-live-session-button"
            className="flex items-center gap-1 rounded border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-600 transition-colors hover:bg-emerald-500/25 disabled:opacity-50 dark:text-emerald-400"
          >
            <Radio className="h-3 w-3" />
            {workerSession.hasLiveSession ? (
              <Trans>Live session</Trans>
            ) : startingSession ? (
              <Trans>Starting…</Trans>
            ) : (
              <Trans>Start live session</Trans>
            )}
          </button>
        )}
        {canPickup && (
          <button
            type="button"
            onClick={() => void handlePickup()}
            disabled={pickingUp}
            title={t`Join this support ticket so you can reply`}
            data-testid="pickup-conversation-button"
            className="flex items-center gap-1 rounded border border-violet-500/40 bg-violet-500/15 px-2 py-0.5 text-[11px] font-medium text-violet-600 transition-colors hover:bg-violet-500/25 disabled:opacity-50 dark:text-violet-400"
          >
            <LifeBuoy className="h-3 w-3" />
            {pickingUp ? <Trans>Picking up…</Trans> : <Trans>Pick up</Trans>}
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
            if (item.kind === ConversationItemKind.SESSION_GROUP) {
              return (
                <LiveSessionGroup
                  key={item.key}
                  sessionId={item.sessionId}
                  promptCount={item.promptCount}
                  replyCount={item.replyCount}
                  onOpenSession={() => openLiveSession(item.sessionId)}
                >
                  {item.children.map((child) => renderConversationItem(child))}
                </LiveSessionGroup>
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
      <MessageComposer conversationId={conversationId} onSent={() => void refetch()} />

      {executeTarget && (
        <ExecutePromptDialog
          open
          onClose={() => setExecuteTarget(null)}
          contact={executeTarget.contact}
          projectId={executeTarget.projectId}
          onExecute={(autoReply) => runExecute(executeTarget.messageId, autoReply)}
        />
      )}
    </div>
  );
}
