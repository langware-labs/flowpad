import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  Inbox as InboxIcon,
  LifeBuoy,
  Mail,
  MailOpen,
  MailPlus,
  RefreshCw,
  Search,
  SquarePen,
  Trash2,
  UsersRound,
  X,
} from 'lucide-react';
import { Trans } from '@lingui/react/macro';
import { useLingui } from '@lingui/react/macro';
import { notify } from '@src/notifications';
import { NewConversationDialog } from '@src/components/new-conversation-dialog/NewConversationDialog';
import { CreateContactsGroupDialog } from '@src/components/contact-picker/CreateContactsGroupDialog';
import {
  Conversation,
  Agent,
  FlowMessage,
  Invitation,
  QueryRequest,
  TypeId,
  acceptInvitation,
  archiveAllConversations,
  archiveConversation,
  declineInvitation,
  deleteArchivedConversations,
  deleteConversation,
  dataContext,
  dismissConversation,
  fetchConversations,
  isInvitationGoneError,
  leaveConversation,
  listHelpdeskTickets,
  pickupConversation,
  unarchiveConversation,
  type HelpdeskTicket,
  latestPointer,
  type AgentInboxScope,
} from '@sdk';
import { useAuth, useCloudStatus } from '@sdk/react/hooks';
import { useEntitiesQuery, useEntity } from '@src/hooks/entity-hooks';
import { Button } from '@src/components/ui/button';
import { Checkbox } from '@src/components/ui/checkbox';
import { BulkConfirmDialog } from '@src/components/ui/bulk-confirm-dialog';
import { ConfirmDialog } from '@src/components/ui/confirm-dialog';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
import { LoginRequiredOverlay } from '@src/components/login-required-overlay';
import { formatTimeAgo } from '@src/components/project-activity-strip/project-activity-utils';
import { updateMessage, bulkUpdateMessages, searchInbox } from './inbox-api';
import { SourceChip } from '@src/components/conversation/channel-attribution';
import { AttachedChannelsBar } from './AttachedChannelsBar';
import { useContext } from '@src/hooks/useContext';
import {
  conversationFacets,
  actionsFor,
  compareConversationsByRecency,
} from '@src/components/conversation/conversation-category';
import { CategoryChips } from '@src/components/conversation/CategoryChips';
import { MembershipInvitations } from './MembershipInvitations';
import { RowActions } from '@src/components/conversation/RowActions';
import { PLACEHOLDER_FOR_EMPTY_MESSAGE_WITH_PROMPT } from '@src/components/conversation/constants';

type RowDeleteAction =
  | { kind: 'invitation'; invitationId: string; conversationId: string }
  | { kind: 'owner'; conversationId: string }
  | { kind: 'leave'; conversationId: string }
  | { kind: 'local'; conversationId: string };

// ── Time formatter (Gmail-style) ────────────────────────────────────────────
// today → "12:34 PM"  ·  this year → "Apr 28"  ·  older → locale date
function formatGmailTime(iso?: string | Date | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  return d.toLocaleDateString();
}

// ── Conversation list row (Gmail thread row) ────────────────────────────────
// Single line: [sender(s)] [subject — snippet…] [time]
// Click anywhere on the row opens the conversation via its dockPointer.

type InboxViewMode = 'inbox' | 'unread' | 'archived' | 'helpdesk';

interface ConversationListRowProps {
  conv: Conversation;
  isFocused: boolean;
  /** Active inbox view:
   *  - 'inbox'    → hide archived rows (default)
   *  - 'unread'   → show only non-archived rows whose latest FlowMessage is unread
   *  - 'archived' → show ONLY archived rows */
  viewMode: InboxViewMode;
  /** Text search is engaged — the parent already narrowed the list to
   *  matching conversations, so the row must NOT apply the per-mode hide
   *  rule (search spans archived/read rows regardless of the active pill). */
  searchActive: boolean;
  /** Conversation-level archive. Stamps ``Conversation.archived_at = now()``
   *  server-side; row auto-revives when a FlowMessage newer than the stamp
   *  arrives. */
  onArchive: (convId: string) => void;
  /** Conversation-level unarchive — clears ``archived_at`` so the row returns
   *  to the Inbox. */
  onUnarchive: (convId: string) => void;
  onToggleRead: (messageId: string, isRead: boolean) => void;
  /** Whether this row is currently ticked for a bulk (multi-select) action.
   *  Optional so the row can render standalone (e.g. in tests) without the
   *  multi-select host wiring. */
  selected?: boolean;
  /** Toggle this row's membership in the multi-select set. Optional — see
   *  ``selected``. */
  onToggleSelect?: (convId: string) => void;
  /** True while the inbox is in multi-select mode (≥1 row ticked, toolbar
   *  showing). In this mode a body click toggles selection instead of opening
   *  the conversation — so the user can build up / trim the set without
   *  navigating away. Clearing the selection restores open-on-click. */
  selectMode?: boolean;
  /** Caller resolves the appropriate dialog/action mode based on the row's
   *  role + the current cloud user id. */
  onRequestDelete: (action: RowDeleteAction) => void;
  /** Used by the row to figure out whether the local user is the hub-side
   *  owner of the conversation. */
  cloudUserId: string | null;
  /** Reports whether this row will actually render so the parent can decide
   *  whether to show the "No conversations" empty state. */
  onVisibilityChange: (convId: string, visible: boolean) => void;
  refSetter: (el: HTMLDivElement | null) => void;
  agentId?: string;
  allowedMessageIds?: ReadonlySet<string>;
}

export function ConversationListRow({
  conv,
  isFocused,
  viewMode,
  searchActive,
  onArchive,
  onUnarchive,
  onToggleRead,
  selected,
  onToggleSelect,
  selectMode,
  onRequestDelete,
  cloudUserId,
  onVisibilityChange,
  refSetter,
  agentId,
  allowedMessageIds,
}: ConversationListRowProps) {
  const { navigation } = useDockNavigation();

  // For invitation rows the first message IS the only message; for regular
  // rows we want the latest message preview but still need to peek at the
  // first to detect ``kind === 'invitation'``.
  const pointers = (conv.conversationMessageIds ?? []).filter(
    (pointer) => !allowedMessageIds || allowedMessageIds.has(pointer.id),
  );
  const firstPtr = pointers[0];
  // Newest by ts, not last-appended — an ingested mailbox backfills
  // newest-first, so the last pointer there is the OLDEST mail.
  const lastPtr = latestPointer(pointers);
  const firstTypeId = useMemo(() => (firstPtr?.id ? new TypeId(FlowMessage.type, firstPtr.id) : null), [firstPtr?.id]);
  const latestTypeId = useMemo(() => (lastPtr?.id ? new TypeId(FlowMessage.type, lastPtr.id) : null), [lastPtr?.id]);
  const { data: firstMessage } = useEntity<FlowMessage>(firstTypeId);
  const { data: latestMessage } = useEntity<FlowMessage>(latestTypeId);

  const invitationTypeId = useMemo(() => firstMessage?.firstContextOfType?.('invitation') ?? null, [firstMessage]);
  const invitationId = invitationTypeId?.id ?? null;
  const { data: invitation } = useEntity<Invitation>(invitationTypeId);

  // An invitation row (Accept CTA) is shown ONLY to the *recipient* of a
  // still-pending invitation — mirrors RecentConversationsStrip. The first
  // message stays ``kind === 'invitation'`` forever, so it can't drive this
  // on its own: the sender (and everyone post-accept) must see a normal row.
  const { cloudUser, currentUser } = useAuth();
  const myEmail = (cloudUser?.email || currentUser?.email || '').trim().toLowerCase();
  const [accepting, setAccepting] = useState(false);

  // Single source of truth for the row's category (invitation / help desk /
  // archived / unread / active). Replaces the previously-scattered booleans and
  // is shared with RecentConversationsStrip. Viewer-relative facts (invitation,
  // unread) are resolved against the local user here. ``archived`` compares the
  // pointer ts (not the FlowMessage) so it doesn't race the async FM fetch.
  const facets = conversationFacets({
    conv,
    firstMessage,
    latestMessage,
    latestPtrTs: lastPtr?.ts ?? null,
    invitation,
    viewer: { email: myEmail, cloudUserId, localUserId: currentUser?.id ?? null },
  });
  // Alias kept so the existing invitation-row rendering reads cleanly below.
  const isInvitationRow = facets.isInvitation;

  // Trash does different things depending on ownership — say which one
  // up-front so the tooltip distinguishes it from the (reversible) Archive.
  const { t } = useLingui();
  const deleteLabel = !conv.remote
    ? t`Delete — removes permanently`
    : cloudUserId && conv.created_by === cloudUserId
      ? t`Delete for everyone — permanent`
      : t`Leave conversation`;

  // The facets are intrinsic to the conversation; the *hide* rule combines them
  // with the active view + search (view-state, not category):
  //   - 'inbox'     → hide archived rows (default)
  //   - 'archived'  → show ONLY archived rows
  //   - 'unread'    → only non-archived unread rows
  //   - search      → span everything; only half-materialized rows stay hidden
  // ``inLoadingState`` keeps a row whose FlowMessage hasn't landed from rendering blank.
  //
  // Invitation rows are exempt: invitation-ness is driven by the FIRST message
  // (``facets.isInvitation`` ⇐ ``firstMessage``), which IS materialized, and the
  // Accept CTA renders entirely from it. Gating on ``latestMessage`` wrongly hid a
  // valid pending-invitation row whenever a LATER message's FlowMessage entity was
  // unresolved locally (e.g. a pre-accept git-artifact share message that doesn't
  // materialize on the recipient) — the row, its testid, and the Accept button
  // must still render. See RCA debug_log.md #14 (receiver artifact-materialization
  // is a separate follow-up). Preview text may still show a loading affordance.
  const inLoadingState = !isInvitationRow && !!lastPtr && !latestMessage;
  let isHidden: boolean;
  if (searchActive) {
    isHidden = inLoadingState;
  } else if (viewMode === 'archived') {
    isHidden = !facets.isArchived || inLoadingState;
  } else if (viewMode === 'unread') {
    isHidden = facets.isArchived || !facets.isUnread || inLoadingState;
  } else {
    isHidden = facets.isArchived || inLoadingState;
  }

  const convId = conv.id ?? '';
  // useLayoutEffect (not useEffect) so the parent's `visibleIds` state is
  // updated before the browser paints — otherwise a row that ends up visible
  // could briefly co-render with the "No conversations" empty state on the
  // first frame.
  useLayoutEffect(() => {
    if (!convId) return;
    onVisibilityChange(convId, !isHidden);
    return () => onVisibilityChange(convId, false);
  }, [convId, isHidden, onVisibilityChange]);

  // Gmail-style sender column: comma-joined names of everyone who has
  // participated in the thread, with the latest sender first so the most
  // recent author is the lead name. Deduped case-insensitively.
  // Falls back to ``Unknown`` when neither the latest message nor any
  // participant has a name; invitation rows always render the canonical
  // ``Invitation`` placeholder so the violet mail-plus icon reads cleanly.
  // MUST run before the `isHidden` early return so the hook order stays
  // stable across visibility flips (Rules of Hooks).
  const participantNames = useMemo(() => {
    if (isInvitationRow) {
      const inviter = (firstMessage?.sender_name || '').trim();
      return [inviter || t`Invitation`];
    }
    const names: string[] = [];
    const seen = new Set<string>();
    const pushName = (raw: string | null | undefined) => {
      const trimmed = (raw || '').trim();
      if (!trimmed) return;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) return;
      names.push(trimmed);
      seen.add(key);
    };
    pushName(latestMessage?.sender_name);
    for (const p of conv.members ?? []) {
      pushName(p?.name || (p?.email ? p.email.split('@')[0] : ''));
    }
    return names.length > 0 ? names : [t`Unknown`];
  }, [isInvitationRow, firstMessage?.sender_name, latestMessage?.sender_name, conv.members, t]);

  if (isHidden) return null;

  const senderLabel = participantNames.join(', ');
  const count = pointers.length;
  // The inbox subject is the conversation's own user-set / hub-synced title
  // (NewConversationDialog at creation; carried in the bundle on cross-user
  // send). A task that happens to sit in the conversation's shared context is
  // there to drive cwd/project_root and the task-gated chips — it is NOT a
  // title source, so it must not feed the subject. Fall back to the email-style
  // "(no subject)" placeholder only when there's no title. The snippet (latest
  // message preview) still renders after it.
  const subject = isInvitationRow ? t`You've been invited to a conversation` : conv.title?.trim() || t`(no subject)`;
  // ``FlowMessage.text`` is typed string but older rows in the local DB can
  // hold non-string payloads (object-shaped values from earlier schema
  // iterations); ``?.replace`` would TypeError on those. Coerce first.
  const rawText = isInvitationRow ? firstMessage?.text : latestMessage?.text;
  const snippetSource = rawText === PLACEHOLDER_FOR_EMPTY_MESSAGE_WITH_PROMPT ? '' : rawText;
  const snippet = String(snippetSource ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const time = formatGmailTime(conv.updated_date);
  const ago = formatTimeAgo(conv.updated_date);
  const isUnread = facets.isUnread;

  const handleClick = () => {
    // Multi-select mode: a body click toggles this row's selection instead of
    // opening it, so the user can build up / trim the bulk set without being
    // navigated away (and losing the selection). Applies to every row kind,
    // including invitations — the checkbox is shown for them too. Clearing the
    // selection (X / clear-all) restores open-on-click below.
    if (selectMode) {
      if (convId) onToggleSelect?.(convId);
      return;
    }
    if (isInvitationRow) return; // primary action is Accept
    if (!conv.id) return;
    // URL-first: the click ONLY navigates. The Gmail-style auto-mark-read
    // moved to the mounted ConversationView (open-to-read effect), so direct
    // links, banner clicks, and Inbox clicks all behave identically and the
    // backend reconciles InboxManager.unread after the mutation.
    navigation.openDock(DockPointer.forConversation(conv.id, { agentId }));
  };

  const handleAccept = async () => {
    if (!invitationId) return;
    setAccepting(true);
    try {
      await acceptInvitation({ invitation_id: invitationId });
    } catch (e) {
      if (isInvitationGoneError(e)) {
        notify.warning({ title: t`Invitation no longer valid`, id: 'membership-invite' });
      } else {
        console.error('[InboxView] acceptInvitation failed', e);
      }
    } finally {
      setAccepting(false);
    }
  };

  return (
    <div
      ref={refSetter}
      data-testid="inbox-conversation-row"
      data-conversation-id={conv.id ?? ''}
      data-focused={isFocused ? 'true' : 'false'}
      data-unread={isUnread ? 'true' : 'false'}
      data-kind={isInvitationRow ? 'invitation' : 'user'}
      onClick={handleClick}
      data-selected={selected ? 'true' : 'false'}
      className={`group relative flex h-9 ${
        isInvitationRow && !selectMode ? 'cursor-default' : 'cursor-pointer'
      } items-center gap-3 border-b border-border/40 px-3 text-sm transition-colors hover:bg-accent/40 hover:shadow-sm ${
        selected ? 'bg-primary/10' : isFocused ? 'bg-primary/10' : ''
      } ${isUnread ? 'bg-background' : 'bg-muted/20'} ${isInvitationRow ? 'border-l-2 border-s-violet-500/60' : ''}`}
    >
      {/* Multi-select tick. Stops propagation so ticking a row never opens it.
          Always visible per line but faded (light border, dimmed) so it doesn't
          compete with the message content; brightens on hover and when ticked. */}
      <span onClick={(e) => e.stopPropagation()} className="flex shrink-0 items-center">
        <Checkbox
          checked={!!selected}
          onCheckedChange={() => convId && onToggleSelect?.(convId)}
          aria-label={t`Select conversation`}
          data-testid="inbox-row-select"
          className="h-3.5 w-3.5 border-muted-foreground/30 opacity-50 transition-opacity hover:opacity-100 data-[state=checked]:border-primary data-[state=checked]:opacity-100"
        />
      </span>
      <span
        data-testid="inbox-row-sender"
        // ``title`` doubles as the trim-overflow tooltip. Browsers only show
        // the native tooltip when the user hovers, so always setting it is
        // cheap; when the visible label already shows the full list, the
        // hover-text repeats it harmlessly.
        title={senderLabel}
        className={`flex w-44 shrink-0 items-center gap-1 ${isUnread ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}
      >
        {isInvitationRow && <MailPlus className="h-3.5 w-3.5 flex-shrink-0 text-violet-500" aria-label="invitation" />}
        <span className="min-w-0 flex-1 truncate">{senderLabel}</span>
        {!isInvitationRow && count > 1 && (
          <span className="ms-1 shrink-0 font-normal text-muted-foreground">({count})</span>
        )}
      </span>
      <span className="min-w-0 flex-1 truncate" data-testid="inbox-row-subject-line">
        <CategoryChips facets={facets} className="me-1" />
        {/* Channel conversations carry exactly one compact source chip; hub
            rows have no origin and render none — absence means "ours". */}
        <SourceChip origin={latestMessage?.origin} className="me-1" />
        <span className={isUnread ? 'font-semibold text-foreground' : 'text-foreground/80'}>{subject}</span>
        {snippet && (
          <>
            <span className="mx-1 text-muted-foreground">—</span>
            <span className="text-muted-foreground">{snippet}</span>
          </>
        )}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground transition-opacity group-hover:opacity-0">
        {time}
        {ago && <span className="ms-1.5 text-muted-foreground/70">· {ago}</span>}
      </span>
      <RowActions
        specs={actionsFor(facets, {
          invitationId,
          accepting,
          deleteLabel,
          onAccept: () => void handleAccept(),
          onDecline: () => {
            if (conv.id && invitationId) {
              onRequestDelete({ kind: 'invitation', invitationId, conversationId: conv.id });
            }
          },
          onToggleRead: () => latestMessage?.id && onToggleRead(latestMessage.id, isUnread),
          onArchive: () => conv.id && onArchive(conv.id),
          onUnarchive: () => conv.id && onUnarchive(conv.id),
          onDelete: () => {
            if (!conv.id) return;
            if (!conv.remote) {
              onRequestDelete({ kind: 'local', conversationId: conv.id });
            } else if (cloudUserId && conv.created_by === cloudUserId) {
              onRequestDelete({ kind: 'owner', conversationId: conv.id });
            } else {
              onRequestDelete({ kind: 'leave', conversationId: conv.id });
            }
          },
        })}
      />
    </div>
  );
}

// ── InboxView ───────────────────────────────────────────────────────────────

export function InboxView({ agentId }: { agentId?: string } = {}) {
  const { t } = useLingui();
  const [fetching, setFetching] = useState(false);
  // 'inbox' (default) shows active conversations; 'archived' shows only
  // rows whose ``archived_at`` is set and not yet revived by newer activity.
  // "Delete all" is gated behind the 'archived' view — a destructive op only
  // exposed once the user has explicitly archived rows.
  const [viewMode, setViewMode] = useState<InboxViewMode>('inbox');
  // Set of conv ids whose row currently chose to render. Driven by row-level
  // `onVisibilityChange` callbacks so the header badge and empty-state both
  // reflect exactly what the user sees (rows hide themselves when their latest
  // FlowMessage is archived or hasn't materialised yet).
  const [visibleIds, setVisibleIds] = useState<Set<string>>(new Set());
  // Rendered pending membership-invite rows (reported by MembershipInvitations)
  // — only gates the empty state; the unread NUMBER is backend-owned.
  const [membershipPendingCount, setMembershipPendingCount] = useState(0);
  const rowRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());
  const { navigation } = useDockNavigation();
  const { cloudUser } = useAuth();
  // The user's own channels. Hidden until the local user is known — the bar
  // keys its rows on that typeid, and an empty bar would flash meanwhile.
  const { userTypeId } = useContext();
  const cloudUserId = cloudUser?.id ?? null;
  const { connection } = useCloudStatus();
  const hubReachable = connection.status === 'connected' || connection.status === 'verified';

  // Bulk-delete + per-row-delete dialog state.
  const [bulkDialogOpen, setBulkDialogOpen] = useState(false);
  const [showNewConversation, setShowNewConversation] = useState(false);
  const [showNewContactsGroup, setShowNewContactsGroup] = useState(false);
  const [rowDelete, setRowDelete] = useState<RowDeleteAction | null>(null);
  // Multi-select: ids of rows ticked for a bulk mark-read/unread/archive/delete.
  // Constrained to currently-visible rows when actions run, so a stale id left
  // over from a view switch can never act on a hidden conversation.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selDeleteOpen, setSelDeleteOpen] = useState(false);

  const request = useMemo(() => new QueryRequest({ type: Conversation.type }), []);
  const { data: conversations = [], refetch, isLoading, isSuccess } = useEntitiesQuery<Conversation>(request);
  const [agentScope, setAgentScope] = useState<AgentInboxScope | null>(null);
  const refreshAgentScope = useCallback(async () => {
    if (!agentId) return;
    const scope = await new Agent({ id: agentId }).inboxScope();
    setAgentScope(scope);
  }, [agentId]);
  useEffect(() => {
    setAgentScope(null);
  }, [agentId]);
  const conversationKey = conversations
    .map((conversation) => `${conversation.id}:${conversation.updated_date}:${conversation.message_ids}`)
    .join(',');
  useEffect(() => {
    if (agentId) void refreshAgentScope().catch(() => setAgentScope({
      agent_id: agentId,
      source_id: null,
      conversation_ids: [],
      thread_ids: [],
      flow_message_ids: [],
    }));
  }, [agentId, conversationKey, refreshAgentScope]);
  const agentConversationIds = useMemo(
    () => new Set(agentScope?.conversation_ids ?? []),
    [agentScope?.conversation_ids],
  );
  const agentFlowMessageIds = useMemo(
    () => new Set(agentScope?.flow_message_ids ?? []),
    [agentScope?.flow_message_ids],
  );
  const scopedConversations = useMemo(
    () => (agentId ? conversations.filter((conversation) => !!conversation.id && agentConversationIds.has(conversation.id)) : conversations),
    [agentConversationIds, agentId, conversations],
  );

  // Only the FIRST load gets the full-screen "Loading…" state. Every
  // ``refetch()`` (manual hub-pull, mark-read, archive, …) flips ``isLoading``
  // back to true while KEEPING the previous ``data`` — so gating the row list
  // on raw ``isLoading`` blanks the whole list to the spinner and back on every
  // refetch, which is the on-open flicker. Once we've loaded successfully once,
  // a background refetch keeps the existing rows on screen.
  const hasLoadedOnce = useRef(false);
  if (isSuccess) hasLoadedOnce.current = true;
  const initialLoading = (isLoading && !hasLoadedOnce.current) || (agentId !== undefined && agentScope === null);

  // Text search over message bodies — server-side, via the `inbox-search`
  // action rather than a `$LIKE` entity query: under the reference model a
  // channel message's body lives on its SourceItem (the FlowMessage row stores
  // `text: ""`), so the backend searches BOTH residences and hands back
  // conversation ids. Debounced per keystroke; the previous result is held
  // while the next request is in flight so the list doesn't blank.
  const [searchQuery, setSearchQuery] = useState('');
  const needle = searchQuery.trim();
  const searchActive = needle !== '';
  const [matchIds, setMatchIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!searchActive) return;
    let stale = false;
    const timer = setTimeout(() => {
      void searchInbox(needle, agentId).then((ids) => {
        if (!stale) setMatchIds(ids);
      });
    }, 200);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [agentId, needle, searchActive]);

  const sorted = useMemo(() => {
    const list = searchActive ? scopedConversations.filter((c) => c.id && matchIds.has(c.id)) : [...scopedConversations];
    list.sort(compareConversationsByRecency);
    return list;
  }, [scopedConversations, searchActive, matchIds]);

  const handleRowVisibility = useCallback((convId: string, visible: boolean) => {
    setVisibleIds((prev) => {
      const has = prev.has(convId);
      if (visible === has) return prev;
      const next = new Set(prev);
      if (visible) next.add(convId);
      else next.delete(convId);
      return next;
    });
  }, []);

  const visibleCount = visibleIds.size;

  // Unread pip/badge: backend-owned (InboxManager.unread, reflected live via
  // the entity channel) — no client-side recount here anymore.

  const handleRefresh = useCallback(async () => {
    setFetching(true);
    try {
      await fetchConversations(agentId);
      await refreshAgentScope();
      void refetch();
    } finally {
      setFetching(false);
    }
  }, [agentId, refetch, refreshAgentScope]);

  const handleArchive = useCallback(
    async (convId: string) => {
      await archiveConversation({ conversation_id: convId, ...(agentId ? { agent_id: agentId } : {}) });
      void refetch();
    },
    [agentId, refetch],
  );

  const handleUnarchive = useCallback(
    async (convId: string) => {
      await unarchiveConversation({ conversation_id: convId, ...(agentId ? { agent_id: agentId } : {}) });
      void refetch();
    },
    [agentId, refetch],
  );

  const handleToggleRead = useCallback(
    async (id: string, isRead: boolean) => {
      await updateMessage(id, { is_read: isRead }, agentId);
      void refetch();
    },
    [agentId, refetch],
  );

  const handleMarkAllRead = useCallback(async () => {
    // No optimistic zero: the backend reconciles InboxManager.unread after the
    // bulk update (pending invitations legitimately keep it > 0).
    await bulkUpdateMessages({ is_read: true }, agentId);
    void refetch();
  }, [agentId, refetch]);

  const handleArchiveAll = useCallback(async () => {
    // Conversation-level archive — O(threads), not O(messages). Includes
    // empties (zero-message conversations) since archive is now a property
    // of the conversation itself, independent of FlowMessage state.
    await archiveAllConversations(agentId);
    void refetch();
  }, [agentId, refetch]);

  // Compute the bulk-delete bucket breakdown from the locally-known
  // archived conversations. Drives the BulkConfirmDialog summary and the
  // hub-reachability gate. Mirrors the server-side classification in
  // ``handle_conversation_delete_archived``.
  const archivedConvs = useMemo(() => scopedConversations.filter((c) => c.archived_at), [scopedConversations]);
  // Classify a conversation by the user's relationship to it — drives both the
  // bulk-delete confirm summary and the hub-reachability gate. Shared by the
  // "Delete all archived" flow and the multi-select "Delete" flow.
  const seemsInvitationConv = useCallback((c: Conversation) => {
    const pointers = c.conversationMessageIds ?? [];
    // We don't have the FM entity loaded for convs the user never opened, so
    // heuristic: invitation-kind conversations carry the canonical title and at
    // least one pointer. The server's classifier is the source of truth; here
    // we just give the user a reasonable preview.
    return !!pointers[0] && (c.title || '').toLowerCase() === 'invitation';
  }, []);
  const bucketsFor = useCallback(
    (convs: Conversation[]) => {
      let ownerCount = 0;
      let nonOwnerCount = 0;
      let invitationCount = 0;
      let localCount = 0;
      for (const c of convs) {
        if (seemsInvitationConv(c)) {
          invitationCount += 1;
        } else if (!c.remote) {
          localCount += 1;
        } else if (cloudUserId && c.created_by === cloudUserId) {
          ownerCount += 1;
        } else {
          nonOwnerCount += 1;
        }
      }
      return { ownerCount, nonOwnerCount, invitationCount, localCount };
    },
    [cloudUserId, seemsInvitationConv],
  );
  const buckets = useMemo(() => bucketsFor(archivedConvs), [bucketsFor, archivedConvs]);
  const needsHub = buckets.ownerCount + buckets.nonOwnerCount + buckets.invitationCount > 0;

  // ── Multi-select derived state ─────────────────────────────────────────────
  // Only visible rows can be acted on — a selected id left behind by a view
  // switch or a row that hid itself is ignored.
  const selectedConvs = useMemo(
    () => sorted.filter((c) => c.id && selectedIds.has(c.id) && visibleIds.has(c.id)),
    [sorted, selectedIds, visibleIds],
  );
  const selectedCount = selectedConvs.length;
  const selectedBuckets = useMemo(() => bucketsFor(selectedConvs), [bucketsFor, selectedConvs]);
  const selectedNeedsHub =
    selectedBuckets.ownerCount + selectedBuckets.nonOwnerCount + selectedBuckets.invitationCount > 0;
  const allVisibleSelected = visibleCount > 0 && [...visibleIds].every((id) => selectedIds.has(id));

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);
  const toggleSelect = useCallback((convId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(convId)) next.delete(convId);
      else next.add(convId);
      return next;
    });
  }, []);
  const toggleSelectAll = useCallback(() => {
    setSelectedIds((prev) => {
      const allSel = visibleIds.size > 0 && [...visibleIds].every((id) => prev.has(id));
      return allSel ? new Set() : new Set(visibleIds);
    });
  }, [visibleIds]);

  // FlowMessage id of a conversation's latest message — the read/unread flag
  // lives on the message, so bulk read toggles patch the last pointer's FM.
  const latestMessageId = (c: Conversation): string | null => {
    return latestPointer(c.conversationMessageIds)?.id ?? null;
  };

  const handleBulkMarkRead = useCallback(
    async (isRead: boolean) => {
      const ids = selectedConvs.map(latestMessageId).filter((id): id is string => !!id);
      await Promise.all(ids.map((id) => updateMessage(id, { is_read: isRead }, agentId)));
      clearSelection();
      void refetch();
    },
    [agentId, selectedConvs, clearSelection, refetch],
  );

  const handleBulkArchive = useCallback(async () => {
    await Promise.all(
      selectedConvs.map((c) =>
        c.id
          ? archiveConversation({ conversation_id: c.id, ...(agentId ? { agent_id: agentId } : {}) })
          : Promise.resolve(),
      ),
    );
    clearSelection();
    void refetch();
  }, [agentId, selectedConvs, clearSelection, refetch]);

  const handleBulkDelete = useCallback(() => {
    if (selectedConvs.length === 0) return;
    if (selectedNeedsHub && !hubReachable) {
      notify.error({
        title: t`Cloud disconnected`,
        message: t`Reconnect to the cloud to delete shared conversations.`,
      });
      return;
    }
    setSelDeleteOpen(true);
  }, [selectedConvs.length, selectedNeedsHub, hubReachable, t]);

  const runBulkDeleteSelected = useCallback(async () => {
    // No single server endpoint for an arbitrary set, so loop per conversation
    // using the same per-row classification the row's trash button applies.
    const convs = selectedConvs;
    let ok = 0;
    const failed: string[] = [];
    for (const c of convs) {
      if (!c.id) continue;
      try {
        if (seemsInvitationConv(c)) {
          // Hide without notifying the inviter — the selection UI has no place
          // to surface the decline-vs-dismiss choice the per-row dialog offers.
          await dismissConversation({ conversation_id: c.id, ...(agentId ? { agent_id: agentId } : {}) });
        } else if (!c.remote) {
          await deleteConversation({ conversation_id: c.id, mode: 'local', ...(agentId ? { agent_id: agentId } : {}) });
        } else if (cloudUserId && c.created_by === cloudUserId) {
          await deleteConversation({ conversation_id: c.id, mode: 'delete_for_all', ...(agentId ? { agent_id: agentId } : {}) });
        } else {
          await leaveConversation({ conversation_id: c.id, ...(agentId ? { agent_id: agentId } : {}) });
        }
        ok += 1;
      } catch {
        failed.push(c.id.slice(0, 8));
      }
    }
    if (failed.length === 0) {
      notify.success({ title: ok === 1 ? t`Deleted 1 conversation` : t`Deleted ${ok} conversations` });
    } else {
      notify.error({
        title: t`Deleted ${ok}, ${failed.length} failed`,
        message: failed.slice(0, 3).join(', '),
      });
    }
    clearSelection();
    void refetch();
  }, [agentId, selectedConvs, seemsInvitationConv, cloudUserId, clearSelection, refetch, t]);

  const handleDeleteArchived = useCallback(() => {
    if (archivedConvs.length === 0) return;
    if (needsHub && !hubReachable) {
      notify.error({
        title: t`Cloud disconnected`,
        message: t`Reconnect to the cloud to delete shared conversations.`,
      });
      return;
    }
    setBulkDialogOpen(true);
  }, [archivedConvs.length, hubReachable, needsHub, t]);

  const runBulkDelete = useCallback(async () => {
    try {
      const res = await deleteArchivedConversations(agentId);
      const ok = res.deleted?.length ?? 0;
      const failed = res.failed ?? [];
      if (failed.length === 0) {
        notify.success({ title: ok === 1 ? t`Deleted 1 conversation` : t`Deleted ${ok} conversations` });
      } else {
        const firstFew = failed
          .slice(0, 3)
          .map((f) => `${f.id.slice(0, 8)}: ${f.reason}`)
          .join('\n');
        notify.error({
          title: t`Deleted ${ok}, ${failed.length} failed`,
          message: firstFew,
        });
      }
    } catch (e) {
      notify.error({
        title: t`Delete all failed`,
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      void refetch();
    }
  }, [agentId, refetch, t]);

  const handleRowDelete = useCallback(
    (action: RowDeleteAction) => {
      if (action.kind !== 'local' && !hubReachable) {
        notify.error({
          title: t`Cloud disconnected`,
          message: t`Reconnect to the cloud to delete this conversation.`,
        });
        return;
      }
      setRowDelete(action);
    },
    [hubReachable, t],
  );

  const confirmRowDelete = useCallback(async () => {
    if (!rowDelete) return;
    try {
      if (rowDelete.kind === 'invitation') {
        await declineInvitation({ invitation_id: rowDelete.invitationId });
        notify.success({ title: t`Invitation declined` });
      } else if (rowDelete.kind === 'owner') {
        await deleteConversation({
          conversation_id: rowDelete.conversationId,
          mode: 'delete_for_all',
          ...(agentId ? { agent_id: agentId } : {}),
        });
        notify.success({ title: t`Conversation deleted` });
      } else if (rowDelete.kind === 'leave') {
        await leaveConversation({ conversation_id: rowDelete.conversationId, ...(agentId ? { agent_id: agentId } : {}) });
        notify.success({ title: t`Left conversation` });
      } else {
        await deleteConversation({
          conversation_id: rowDelete.conversationId,
          mode: 'local',
          ...(agentId ? { agent_id: agentId } : {}),
        });
        notify.success({ title: t`Conversation deleted` });
      }
    } catch (e) {
      notify.error({
        title: t`Delete failed`,
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      void refetch();
    }
  }, [agentId, refetch, rowDelete, t]);

  const dismissInvitationRow = useCallback(
    async (action: RowDeleteAction) => {
      if (action.kind !== 'invitation') return;
      try {
        await dismissConversation({ conversation_id: action.conversationId, ...(agentId ? { agent_id: agentId } : {}) });
        notify.success({ title: t`Invitation dismissed` });
      } catch (e) {
        notify.error({
          title: t`Dismiss failed`,
          message: e instanceof Error ? e.message : String(e),
        });
      } finally {
        void refetch();
      }
    },
    [agentId, refetch, t],
  );

  const setView = useCallback((next: InboxViewMode) => {
    setViewMode((cur) => {
      if (cur === next) return cur;
      // Visible-ids tracks the previous mode's rows; reset so the count
      // badge doesn't flash stale during the swap. Selection is per-view, so
      // drop it too — carrying ticks across modes would act on hidden rows.
      setVisibleIds(new Set());
      setSelectedIds(new Set());
      return next;
    });
  }, []);

  const inArchivedView = viewMode === 'archived';
  const inUnreadView = viewMode === 'unread';
  const inHelpdeskView = viewMode === 'helpdesk';

  // Staff helpdesk ticket queue. Sourced from the hub (not local entities)
  // because unpicked tickets don't fan out to non-participants — see
  // listHelpdeskTickets / hub Project.helpdesk_conversations.
  const [helpdeskTickets, setHelpdeskTickets] = useState<HelpdeskTicket[]>([]);
  const [helpdeskLoading, setHelpdeskLoading] = useState(false);
  const [pickingUpId, setPickingUpId] = useState<string | null>(null);
  const loadHelpdeskTickets = useCallback(async () => {
    setHelpdeskLoading(true);
    try {
      const res = await listHelpdeskTickets(dataContext.project?.id);
      setHelpdeskTickets(res.tickets ?? []);
    } catch (err) {
      console.error('[inbox] failed to load help desk tickets', err);
      setHelpdeskTickets([]);
    } finally {
      setHelpdeskLoading(false);
    }
  }, []);
  useEffect(() => {
    if (inHelpdeskView) void loadHelpdeskTickets();
  }, [inHelpdeskView, loadHelpdeskTickets]);

  // Open a queued ticket: pick it up first (joins the roster so the caller can
  // read + reply) unless already joined, then navigate to it.
  const handleOpenTicket = useCallback(
    async (ticket: HelpdeskTicket) => {
      if (!ticket.picked_up) {
        setPickingUpId(ticket.conversation_id);
        try {
          await pickupConversation(ticket.conversation_id);
        } catch (err) {
          console.error('[inbox] pickup failed', ticket.conversation_id, err);
          setPickingUpId(null);
          return;
        }
        setPickingUpId(null);
      }
      navigation.openDock(DockPointer.forConversation(ticket.conversation_id));
    },
    [navigation],
  );

  // Segmented view pill — Inbox | Unread | Archived. Active mode is filled,
  // inactive is ghost. Count badge sits inside the active pill so it
  // reflects exactly what the user is looking at.
  const renderViewPill = (mode: InboxViewMode, label: string, Icon: typeof InboxIcon) => {
    const active = viewMode === mode;
    return (
      <button
        type="button"
        onClick={() => setView(mode)}
        className={`flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium transition-colors ${
          active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
        }`}
        data-testid={`inbox-view-${mode}`}
        aria-pressed={active}
      >
        <Icon className="h-3.5 w-3.5" />
        <span>{label}</span>
        {active && visibleCount > 0 && (
          // Fixed min-width + tabular figures: the badge keeps the same box up
          // to three digits, so a growing count doesn't reflow the search input
          // and the buttons to its right.
          <span className="inline-block min-w-[30px] rounded bg-muted px-1.5 py-0.5 text-center text-[10px] tabular-nums text-muted-foreground">
            {visibleCount}
          </span>
        )}
      </button>
    );
  };

  // List mode
  return (
    <div className="relative flex h-full flex-col">
      {!cloudUser && (
        <LoginRequiredOverlay
          description={t`Sign in to your Flowpad Cloud account to view your inbox and conversations.`}
        />
      )}
      <div className="flex shrink-0 items-center border-b px-3 py-1.5">
        {/* LEFT — view selector. flex-1 here + on RIGHT keeps the CENTER truly centered. */}
        <div className="flex flex-1 items-center">
          <div
            className="flex items-center gap-0.5 rounded-md bg-muted/40 p-0.5"
            role="tablist"
            aria-label={t`Inbox view`}
            data-testid="inbox-view-bar"
          >
            {renderViewPill('inbox', t`Inbox`, InboxIcon)}
            {renderViewPill('unread', t`Unread`, MailPlus)}
            {renderViewPill('archived', t`Archived`, Archive)}
            {!agentId && renderViewPill('helpdesk', t`Help Desk`, LifeBuoy)}
          </div>
          {!agentId && userTypeId && <AttachedChannelsBar owner={userTypeId} className="ms-2" />}
          {/* Text search — filters the list below to conversations whose
              messages contain the query, spanning archived rows. Hidden in
              the Help Desk view (hub-sourced tickets, not local messages). */}
          {!inHelpdeskView && (
            <div className="relative ms-2 flex items-center">
              <Search className="pointer-events-none absolute left-2 h-3.5 w-3.5 text-muted-foreground" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t`Search messages`}
                className="h-7 w-44 rounded-md border border-border/60 bg-background pe-6 ps-7 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                data-testid="inbox-search-input"
                aria-label={t`Search messages`}
              />
              {searchActive && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="absolute right-1.5 rounded p-0.5 text-muted-foreground hover:text-foreground"
                  aria-label={t`Clear search`}
                  data-testid="inbox-search-clear"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          )}
        </div>
        {/* CENTER — new conversation / new contacts group */}
        {!agentId && <div className="flex shrink-0 items-center">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={() => setShowNewConversation(true)}
            data-testid="inbox-new-conversation-button"
            title={t`Start a new conversation`}
          >
            <SquarePen className="me-1 h-3.5 w-3.5" />
            <Trans>New</Trans>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={() => setShowNewContactsGroup(true)}
            data-testid="inbox-new-contacts-group-button"
            title={t`Create a contacts group — add its members to any conversation in one click`}
          >
            <UsersRound className="me-1 h-3.5 w-3.5" />
            <Trans>New group</Trans>
          </Button>
        </div>}
        {/* RIGHT — actions for the current view */}
        <div className="flex flex-1 items-center justify-end gap-1" data-testid="inbox-action-bar">
          {selectedCount > 0 && !inHelpdeskView ? (
            <div className="flex items-center gap-1" data-testid="inbox-selection-bar">
              <span className="me-1 text-xs text-muted-foreground" data-testid="inbox-selection-count">
                <Trans>{selectedCount} selected</Trans>
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={() => void handleBulkMarkRead(true)}
                data-testid="inbox-selection-mark-read"
              >
                <MailOpen className="me-1 h-3.5 w-3.5" />
                <Trans>Read</Trans>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={() => void handleBulkMarkRead(false)}
                data-testid="inbox-selection-mark-unread"
              >
                <Mail className="me-1 h-3.5 w-3.5" />
                <Trans>Unread</Trans>
              </Button>
              {!inArchivedView && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => void handleBulkArchive()}
                  data-testid="inbox-selection-archive"
                >
                  <Archive className="me-1 h-3.5 w-3.5" />
                  <Trans>Archive</Trans>
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => void handleBulkDelete()}
                data-testid="inbox-selection-delete"
              >
                <Trash2 className="me-1 h-3.5 w-3.5" />
                <Trans>Delete</Trans>
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={clearSelection}
                title={t`Clear selection`}
                data-testid="inbox-selection-clear"
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          ) : (
            <>
              {inHelpdeskView && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => void loadHelpdeskTickets()}
                  disabled={helpdeskLoading}
                  title={t`Refresh help desk tickets`}
                  data-testid="inbox-helpdesk-refresh-button"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${helpdeskLoading ? 'animate-spin' : ''}`} />
                </Button>
              )}
              {!inArchivedView && !inHelpdeskView && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => void handleMarkAllRead()}
                  disabled={isLoading || visibleCount === 0}
                >
                  <Trans>Mark all read</Trans>
                </Button>
              )}
              {/* Archive all archives every conversation regardless of read state;
              hide it in the Archived view where it makes no sense. */}
              {!inArchivedView && !inUnreadView && !inHelpdeskView && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => void handleArchiveAll()}
                  disabled={isLoading || visibleCount === 0}
                  data-testid="inbox-archive-all-button"
                >
                  <Trans>Archive all</Trans>
                </Button>
              )}
              {inArchivedView && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => void handleDeleteArchived()}
                  disabled={isLoading || visibleCount === 0}
                  data-testid="inbox-delete-archived-button"
                >
                  <Trash2 className="me-1 h-3.5 w-3.5" />
                  <Trans>Delete all</Trans>
                </Button>
              )}
              {!inHelpdeskView && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => void handleRefresh()}
                  disabled={fetching}
                  title={t`Fetch new messages from hub`}
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${fetching ? 'animate-spin' : ''}`} />
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Help-desk staff queue — hub-sourced tickets, including unpicked ones
            that don't appear in the local conversation list. */}
        {inHelpdeskView && helpdeskLoading && helpdeskTickets.length === 0 && (
          <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
            <Trans>Loading…</Trans>
          </div>
        )}
        {inHelpdeskView && !helpdeskLoading && helpdeskTickets.length === 0 && (
          <div className="flex h-48 flex-col items-center justify-center gap-3 text-muted-foreground">
            <span className="text-sm">
              <Trans>No help desk tickets</Trans>
            </span>
            <Button variant="outline" size="sm" onClick={() => void loadHelpdeskTickets()} disabled={helpdeskLoading}>
              <RefreshCw className={`me-1.5 h-3.5 w-3.5 ${helpdeskLoading ? 'animate-spin' : ''}`} />
              <Trans>Refresh</Trans>
            </Button>
          </div>
        )}
        {inHelpdeskView &&
          helpdeskTickets.map((ticket) => (
            <div
              key={ticket.conversation_id}
              className="group flex items-center gap-2 border-b px-3 py-2 hover:bg-muted/40"
              data-testid="helpdesk-ticket-row"
              data-conversation-id={ticket.conversation_id}
            >
              <LifeBuoy className="h-3.5 w-3.5 shrink-0 text-violet-500" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-foreground">
                  {ticket.title || ticket.preview || t`Support ticket`}
                </div>
                {ticket.preview && ticket.title && (
                  <div className="truncate text-xs text-muted-foreground">{ticket.preview}</div>
                )}
              </div>
              <span className="shrink-0 text-[11px] text-muted-foreground">
                <Trans>{ticket.message_count} msg</Trans>
              </span>
              {ticket.picked_up && (
                <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  <Trans>Joined</Trans>
                </span>
              )}
              <button
                type="button"
                onClick={() => void handleOpenTicket(ticket)}
                disabled={pickingUpId === ticket.conversation_id}
                className="shrink-0 rounded bg-violet-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-violet-700 disabled:opacity-50"
                data-testid="helpdesk-ticket-pickup-button"
              >
                {pickingUpId === ticket.conversation_id ? t`Picking up…` : ticket.picked_up ? t`Open` : t`Pick up`}
              </button>
            </div>
          ))}

        {!inHelpdeskView && initialLoading && (
          <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
            <Trans>Loading…</Trans>
          </div>
        )}

        {!inHelpdeskView && !initialLoading && visibleCount === 0 && membershipPendingCount === 0 && (
          <div className="flex h-48 flex-col items-center justify-center gap-3 text-muted-foreground">
            <span className="text-sm">
              {searchActive
                ? t`No matching conversations`
                : inArchivedView
                  ? t`No archived conversations`
                  : inUnreadView
                    ? t`No unread conversations`
                    : t`No conversations`}
            </span>
            {!inArchivedView && !searchActive && (
              <Button variant="outline" size="sm" onClick={() => void handleRefresh()} disabled={fetching}>
                <RefreshCw className={`me-1.5 h-3.5 w-3.5 ${fetching ? 'animate-spin' : ''}`} />
                <Trans>Check for new messages</Trans>
              </Button>
            )}
          </div>
        )}

        {!inHelpdeskView && !initialLoading && visibleCount > 0 && (
          <div
            className="flex h-7 items-center gap-3 border-b border-border/40 bg-muted/10 px-3"
            data-testid="inbox-select-all-row"
          >
            <Checkbox
              checked={allVisibleSelected ? true : selectedCount > 0 ? 'indeterminate' : false}
              onCheckedChange={toggleSelectAll}
              aria-label={t`Select all conversations`}
              data-testid="inbox-select-all"
              className="h-3.5 w-3.5"
            />
            <span className="text-xs text-muted-foreground">
              {selectedCount > 0 ? <Trans>{selectedCount} selected</Trans> : t`Select all`}
            </span>
          </div>
        )}

        {!agentId && !inHelpdeskView && !inArchivedView && !initialLoading && (
          <MembershipInvitations recipientEmail={cloudUser?.email ?? null} onPendingCount={setMembershipPendingCount} />
        )}

        {!inHelpdeskView &&
          !initialLoading &&
          sorted.map((conv) => (
            <ConversationListRow
              key={conv.id ?? ''}
              conv={conv}
              isFocused={false}
              viewMode={viewMode}
              searchActive={searchActive}
              onArchive={(convId) => void handleArchive(convId)}
              onUnarchive={(convId) => void handleUnarchive(convId)}
              onToggleRead={(messageId, isRead) => void handleToggleRead(messageId, isRead)}
              selected={!!conv.id && selectedIds.has(conv.id)}
              onToggleSelect={toggleSelect}
              selectMode={selectedCount > 0}
              onRequestDelete={handleRowDelete}
              cloudUserId={cloudUserId}
              onVisibilityChange={handleRowVisibility}
              refSetter={(el) => {
                if (conv.id) rowRefs.current.set(conv.id, el);
              }}
              agentId={agentId}
              allowedMessageIds={agentId ? agentFlowMessageIds : undefined}
            />
          ))}
      </div>

      {!agentId && <NewConversationDialog open={showNewConversation} onClose={() => setShowNewConversation(false)} />}

      {!agentId && <CreateContactsGroupDialog open={showNewContactsGroup} onOpenChange={setShowNewContactsGroup} />}

      <BulkConfirmDialog
        open={bulkDialogOpen}
        onOpenChange={setBulkDialogOpen}
        title={t`Delete archived conversations`}
        intro={
          needsHub ? t`This sends a cloud action per conversation:` : t`These conversations exist only on this device.`
        }
        buckets={[
          {
            label: t`You own — delete for everyone`,
            count: buckets.ownerCount,
            tone: 'destructive',
            description: t`Removed for all participants`,
          },
          {
            label: t`You will leave`,
            count: buckets.nonOwnerCount,
            description: t`Removed for you; other members keep it`,
          },
          {
            label: t`Invitations — decline`,
            count: buckets.invitationCount,
            description: t`Notifies the inviter`,
          },
          {
            label: t`Local only — permanent`,
            count: buckets.localCount,
            tone: 'destructive',
            description: t`Never synced to cloud`,
          },
        ]}
        confirmLabel={t`Delete all`}
        onConfirm={() => void runBulkDelete()}
      />

      <BulkConfirmDialog
        open={selDeleteOpen}
        onOpenChange={setSelDeleteOpen}
        title={selectedCount === 1 ? t`Delete 1 conversation` : t`Delete ${selectedCount} conversations`}
        intro={
          selectedNeedsHub
            ? t`This sends a cloud action per conversation:`
            : t`These conversations exist only on this device.`
        }
        buckets={[
          {
            label: t`You own — delete for everyone`,
            count: selectedBuckets.ownerCount,
            tone: 'destructive',
            description: t`Removed for all participants`,
          },
          {
            label: t`You will leave`,
            count: selectedBuckets.nonOwnerCount,
            description: t`Removed for you; other members keep it`,
          },
          {
            label: t`Invitations — dismiss`,
            count: selectedBuckets.invitationCount,
            description: t`Hidden from your inbox`,
          },
          {
            label: t`Local only — permanent`,
            count: selectedBuckets.localCount,
            tone: 'destructive',
            description: t`Never synced to cloud`,
          },
        ]}
        confirmLabel={t`Delete`}
        onConfirm={() => void runBulkDeleteSelected()}
      />

      {rowDelete?.kind === 'invitation' && (
        <BulkConfirmDialog
          open
          onOpenChange={(o) => !o && setRowDelete(null)}
          title={t`Invitation`}
          intro={t`Pick what to do with this invitation.`}
          buckets={[
            {
              label: t`Decline (notifies the inviter)`,
              count: 1,
              tone: 'destructive',
              description: t`Removes it everywhere`,
            },
          ]}
          confirmLabel={t`Decline`}
          cancelLabel={t`Cancel`}
          onConfirm={() => {
            void confirmRowDelete();
            setRowDelete(null);
          }}
          onCancel={() => {
            // Offer the "dismiss" path explicitly so the user can hide the
            // row without notifying the inviter. We fire it from the cancel
            // handler so the dialog is closed first.
            void dismissInvitationRow(rowDelete);
          }}
        />
      )}

      {rowDelete?.kind === 'owner' && (
        <BulkConfirmDialog
          open
          onOpenChange={(o) => !o && setRowDelete(null)}
          title={t`Delete this conversation`}
          intro={t`You own this conversation — pick how you want to leave.`}
          buckets={[
            {
              label: t`Delete for everyone`,
              count: 1,
              tone: 'destructive',
              description: t`Removed for all participants on the cloud`,
            },
          ]}
          confirmLabel={t`Delete for everyone`}
          onConfirm={() => {
            void confirmRowDelete();
            setRowDelete(null);
          }}
        />
      )}

      {rowDelete?.kind === 'leave' && (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setRowDelete(null)}
          title={t`Leave this conversation?`}
          description={t`You'll be removed from the participant list. Other members keep the conversation.`}
          confirmLabel={t`Leave`}
          variant="destructive"
          onConfirm={() => {
            void confirmRowDelete();
            setRowDelete(null);
          }}
        />
      )}

      {rowDelete?.kind === 'local' && (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setRowDelete(null)}
          title={t`Permanently delete?`}
          description={t`This conversation is local-only. It will be removed from this device.`}
          confirmLabel={t`Delete`}
          variant="destructive"
          onConfirm={() => {
            void confirmRowDelete();
            setRowDelete(null);
          }}
        />
      )}
    </div>
  );
}
