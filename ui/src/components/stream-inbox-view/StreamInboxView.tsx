import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { markdownToPlain } from '@src/components/conversation/message-markdown';
import type { CSSProperties, Dispatch, PointerEvent as ReactPointerEvent, ReactNode, SetStateAction } from 'react';
import {
  Archive,
  BookUser,
  Inbox as InboxIcon,
  Mail,
  MailOpen,
  MailPlus,
  RefreshCw,
  Search,
  SquarePen,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import { Trans } from '@lingui/react/macro';
import { useLingui } from '@lingui/react/macro';
import { notify } from '@src/notifications';
import { pullNow } from '@src/components/data-sources/source-parts';
import { NewConversationDialog } from '@src/components/new-conversation-dialog/NewConversationDialog';
import { ContactsDialog } from '@src/components/contact-picker/ContactsDialog';
import {
  Conversation,
  FlowMessage,
  Invitation,
  QueryRequest,
  TypeId,
  answerInvitation,
  archiveAllConversations,
  archiveConversation,
  deleteArchivedConversations,
  deleteConversation,
  dismissConversation,
  fetchConversations,
  isInvitationGoneError,
  leaveConversation,
  unarchiveConversation,
  conversationRowMessageIds,
  isProcessFailed,
  isProcessLive,
  type AgenticProcess,
} from '@sdk';
import { useAuth, useCloudStatus } from '@sdk/react/hooks';
import { useEntitiesQuery, useEntity } from '@src/hooks/entity-hooks';
import { EntityBatchHydrator, useEntityBatchState } from '@src/components/entity-batch/EntityBatchHydrator';
import { useConversationAutomationMarks } from '@src/hooks/conversation/useMessageAutomationSessions';
import { Button } from '@src/components/ui/button';
import { cn } from '@src/lib/utils';
import { Checkbox } from '@src/components/ui/checkbox';
import { BulkConfirmDialog } from '@src/components/ui/bulk-confirm-dialog';
import { ConfirmDialog } from '@src/components/ui/confirm-dialog';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import {
  DockPointer,
  STREAM_INBOX_CHANNEL_PARAM,
  type StreamInboxColumns,
  type StreamInboxDateWindow,
} from '@src/navigation/DockPointer';
import { useDebounced } from '@src/hooks/useDebounced';
import { LoginRequiredOverlay } from '@src/components/login-required-overlay';
import { formatTimeAgo } from '@src/components/project-activity-strip/project-activity-utils';
import { updateMessage, bulkUpdateMessages, searchStreamInbox } from './stream-inbox-api';
import { isHubOnly } from '@src/navigation/hub-runtime';
import {
  type ChannelAttribution,
  SourceChip,
  sourceForOrigin,
  useChannelAttribution,
} from '@src/components/conversation/channel-attribution';
import { AttachedChannelsBar, ConnectChannelPrompt, useAttachedChannels } from './AttachedChannelsBar';
import {
  BUILT_IN_CHANNELS,
  FLOWPAD_CHANNEL,
  channelKeyOf,
  channelsOwnerFor,
  type ConversationScope,
  conversationsByIdsRequest,
  conversationsPageRequest,
  STREAM_INBOX_PAGE_SIZE,
  type StreamInboxViewMode,
} from './channel-owner';
import { useUiActionRequest } from '@src/navigation/ui-actions';
import { StreamInboxPager } from './StreamInboxPager';
import { useContext } from '@src/hooks/useContext';
import { useStreamInboxManager } from '@src/hooks/useStreamInboxManager';
import {
  conversationFacets,
  actionsFor,
  compareConversationsByRecency,
  isDeskTicket,
  isViewer,
} from '@src/components/conversation/conversation-category';
import { authoredBy, senderOf } from '@sdk/models/MessageSender';
import { labelForType } from '@src/components/graph-view/icons/iconRegistry';
import { CategoryChips, COMPACT } from '@src/components/conversation/CategoryChips';
import { ConversationMarkChips } from '@src/components/conversation/ChannelMessageExtras';
import { InvitesChannelChip, MembershipInvitations } from './MembershipInvitations';
import { InviteStateChip } from '@src/components/conversation/InviteCard';
import { ProjectUploadMessageButton } from '@src/components/project-home/ProjectUploadMessageButton';
import { RowActions } from '@src/components/conversation/RowActions';
import { attachmentSummary } from '@src/components/conversation/useAttachments';
import { ConversationAttachmentsButton } from './ConversationAttachmentsButton';
import { personName } from '@src/components/conversation/participant-display';

/** Row actions on this machine's own state (read marks, archive): the hub page offers none. */
const PER_MACHINE_ROW_ACTIONS = new Set(['toggle-read', 'archive', 'unarchive']);

/** What removing a conversation does for this viewer: a row that never reached the hub (``remote: false``
 *  — a hub row carries no flag) is deleted here; the hub's owner (``initiated_by``) deletes it for everyone;
 *  anyone else leaves. One rule for the row, the bulk counts and the bulk delete. */
export function deleteKindOf(
  conv: Pick<Conversation, 'remote' | 'initiated_by'>,
  cloudUserId: string | null | undefined,
): 'local' | 'owner' | 'leave' {
  if (conv.remote === false) return 'local';
  return conv.initiated_by && conv.initiated_by === cloudUserId ? 'owner' : 'leave';
}

type RowDeleteAction =
  | { kind: 'invitation'; invitationId: string; conversationId: string }
  | { kind: 'owner'; conversationId: string }
  | { kind: 'leave'; conversationId: string }
  | { kind: 'local'; conversationId: string };

// ── Time formatter (Gmail-style) ────────────────────────────────────────────
// today → "12:34 PM"  ·  this year → "Apr 28"  ·  older → locale date
// Every row formats its time on every render of the list, and the list re-renders on each
// conversation/message change: ``toLocale*String(undefined, opts)`` builds a fresh
// Intl.DateTimeFormat per call (311 ms of one create in a profile). One formatter per shape.
const TIME_FMT = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const DAY_FMT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const DATE_FMT = new Intl.DateTimeFormat(undefined);
/** "Shared task: I was asked by Patty…" — what was shared, in a few words of its name. */
function sharedSubject(
  t: ReturnType<typeof useLingui>['t'],
  invite?: { target_type?: string; target_name?: string | null } | null,
): string {
  const words = (invite?.target_name || '').trim().split(/\s+/).filter(Boolean);
  const name = words.slice(0, 6).join(' ') + (words.length > 6 ? '…' : '');
  if (!invite?.target_type) return t`Shared with you`;
  const kind = labelForType(invite.target_type).toLowerCase();
  return name ? t`Shared ${kind}: ${name}` : t`Shared ${kind}`;
}

function formatGmailTime(iso?: string | Date | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) {
    return TIME_FMT.format(d);
  }
  if (d.getFullYear() === now.getFullYear()) {
    return DAY_FMT.format(d);
  }
  return DATE_FMT.format(d);
}

// ── Conversation list row (Gmail thread row) ────────────────────────────────
// Single line: [sender(s)] [subject — snippet…] [time]
// Click anywhere on the row opens the conversation via its dockPointer.

function readStoredChannels(key: string | null): string[] {
  if (!key) return [];
  try {
    const v = JSON.parse(window.localStorage.getItem(key) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

// ── Column filters ──────────────────────────────────────────────────────────
// One filter per row column, typed into the header line above that column:
// From narrows on the sender names, Subject on the subject + preview text,
// Date on the conversation's last activity. URL-owned (`?from=&subject=&date=`), like the search.
const NO_COLUMN_FILTER: StreamInboxColumns = { from: '', subject: '', date: 'any' };

function sameColumns(a: StreamInboxColumns, b: StreamInboxColumns): boolean {
  return a.from === b.from && a.subject === b.subject && a.date === b.date;
}

/** A box whose value the dock URL owns: it types into a local draft and commits after a pause, so
 *  history doesn't take one entry per keystroke. Back/forward re-seeds the draft. */
function useUrlDraft<T>(
  urlValue: T,
  commit: (value: T) => void,
  same: (a: T, b: T) => boolean = Object.is,
): [T, Dispatch<SetStateAction<T>>] {
  const [draft, setDraft] = useState(urlValue);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setDraft((cur) => (same(cur, urlValue) ? cur : urlValue)), [urlValue]);
  const settled = useDebounced(draft);
  useEffect(() => {
    if (!same(settled, urlValue)) commit(settled);
    // Commit only when the typed text settles; a dock change alone must not re-commit stale text.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled]);
  return [draft, setDraft];
}

function isColumnFilterActive(f: StreamInboxColumns): boolean {
  return f.from.trim() !== '' || f.subject.trim() !== '' || f.date !== 'any';
}

function windowStart(date: StreamInboxDateWindow): number | null {
  if (date === 'any') return null;
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  if (date === '7d') d.setDate(d.getDate() - 6);
  if (date === '30d') d.setDate(d.getDate() - 29);
  return d.getTime();
}

export function matchesColumnFilter(
  f: StreamInboxColumns,
  row: { senders: string; subjectLine: string; updated?: string | Date | null },
): boolean {
  const from = f.from.trim().toLowerCase();
  if (from && !row.senders.toLowerCase().includes(from)) return false;
  const subject = f.subject.trim().toLowerCase();
  if (subject && !row.subjectLine.toLowerCase().includes(subject)) return false;
  const start = windowStart(f.date);
  if (start !== null) {
    const ts = row.updated ? new Date(row.updated).getTime() : NaN;
    if (Number.isNaN(ts) || ts < start) return false;
  }
  return true;
}

interface ConversationListRowProps {
  /** The newest session an automation started on a message of this conversation. */
  automationMark?: AgenticProcess;
  conv: Conversation;
  /** What the row shows of `conv` and `automationMark`, as one string (`rowRevision`). The store
   *  updates an entity IN PLACE, so its identity never says it changed — this does, and lets an
   *  unchanged row skip the list's re-renders (`memo`). */
  revision: string;
  isFocused: boolean;
  /** Conversation-level archive. Stamps ``Conversation.archived_at = now()``
   *  server-side; row auto-revives when a FlowMessage newer than the stamp
   *  arrives. */
  onArchive: (convId: string) => void;
  /** Conversation-level unarchive — clears ``archived_at`` so the row returns
   *  to the stream inbox. */
  onUnarchive: (convId: string) => void;
  onToggleRead: (messageId: string, isRead: boolean) => void;
  /** Whether this row is currently ticked for a bulk (multi-select) action.
   *  Optional so the row can render standalone (e.g. in tests) without the
   *  multi-select host wiring. */
  selected?: boolean;
  /** Toggle this row's membership in the multi-select set. Optional — see
   *  ``selected``. */
  onToggleSelect?: (convId: string) => void;
  /** True while the stream inbox is in multi-select mode (≥1 row ticked, toolbar
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
  /** Set while the list is narrowed to some channels: does this message's source pass? */
  channelMatch?: (message: FlowMessage, conversation: Conversation) => boolean;
  /** Set while a header column filter is engaged. */
  columnFilter?: StreamInboxColumns;
  /** The list resolves attribution once and hands each row its answer. */
  attributionFor: (
    origin: FlowMessage['origin'],
    originLocal?: FlowMessage['origin_local'],
    channelSpec?: Conversation['channel_spec'],
  ) => ChannelAttribution | null;
  refSetter: (convId: string, el: HTMLDivElement | null) => void;
  agentId?: string;
  /** A host that shows the conversation itself (a source's page): where a row opens. Still URL-first — the host
   *  navigates. Omitted: the conversation view, scoped to `agentId`. */
  onOpenConversation?: (conversationId: string) => void;
}

/** `ConversationListRow`'s `revision`: everything stored on the row's conversation, plus its
 *  automation mark's state. A field the row reads through a hook (its messages, the viewer)
 *  re-renders it on its own. */
export function rowRevision(conv: Conversation, automationMark?: AgenticProcess): string {
  return `${entityRevision(conv)}|${automationMark?.id ?? ''}:${automationMark?.status ?? ''}`;
}

/** Every own field of an entity (stored, projected and private alike), as JSON. One that cannot
 *  be written out reads as changed every time — a re-render, never a stale row. */
function entityRevision(entity: object): string {
  const fields: Record<string, unknown> = {};
  for (const key of Object.keys(entity)) {
    const value = (entity as Record<string, unknown>)[key];
    if (typeof value !== 'function') fields[key] = value;
  }
  try {
    return JSON.stringify(fields);
  } catch {
    return `unserializable:${Math.random()}`;
  }
}

/**
 * Memoized, so a list re-render (a filter keystroke, a row reporting its visibility, a message
 * batch landing) repaints only the rows whose own props moved: the StreamInbox re-rendered ~12 times
 * while opening and every row rendered with it (500 row renders for 100 rows).
 */
export const ConversationListRow = memo(function ConversationListRow({
  conv,
  isFocused,
  onArchive,
  onUnarchive,
  onToggleRead,
  selected,
  onToggleSelect,
  selectMode,
  onRequestDelete,
  cloudUserId,
  onVisibilityChange,
  channelMatch,
  columnFilter,
  attributionFor,
  refSetter,
  agentId,
  onOpenConversation,
  automationMark,
}: ConversationListRowProps) {
  const rowId = conv.id;
  const rowRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (rowId) refSetter(rowId, el);
    },
    [rowId, refSetter],
  );
  const { navigation } = useDockNavigation();
  const desktopStreamInbox = !isHubOnly();

  // For invitation rows the first message IS the only message; for regular
  // rows we want the latest message preview but still need to peek at the
  // first to detect ``kind === 'invitation'``.
  const pointers = conv.conversationMessageIds ?? [];
  const firstPtr = pointers[0];
  // Newest by ts, not last-appended — an ingested mailbox backfills
  // newest-first, so the last pointer there is the OLDEST mail.
  const lastPtr = conv.latestMessagePointer;
  const firstTypeId = useMemo(() => (firstPtr?.id ? new TypeId(FlowMessage.type, firstPtr.id) : null), [firstPtr?.id]);
  const latestTypeId = useMemo(() => (lastPtr?.id ? new TypeId(FlowMessage.type, lastPtr.id) : null), [lastPtr?.id]);
  const { data: firstMessage } = useEntity<FlowMessage>(firstTypeId);
  const { data: pointedLatest } = useEntity<FlowMessage>(latestTypeId);
  // A row IS its conversation; its preview loading never hides it. When a new message moves the
  // latest pointer, the row keeps the message it last showed until the new one resolves — only a
  // row that has never shown one waits hidden (`inLoadingState`).
  const shownLatest = useRef<{ convId: string; message: FlowMessage } | null>(null);
  if (pointedLatest) shownLatest.current = { convId: conv.id ?? '', message: pointedLatest };
  const latestMessage =
    pointedLatest ??
    (latestTypeId && shownLatest.current?.convId === (conv.id ?? '') ? shownLatest.current.message : undefined);

  const invitationTypeId = useMemo(() => firstMessage?.firstContextOfType?.('invitation') ?? null, [firstMessage]);
  const invitationId = invitationTypeId?.id ?? null;
  const { data: invitation } = useEntity<Invitation>(invitationTypeId);

  // An invitation row (Accept CTA) is shown ONLY to the *recipient* of a
  // still-pending invitation — mirrors RecentConversationsStrip. The first
  // message stays ``kind === 'invitation'`` forever, so it can't drive this
  // on its own: the sender (and everyone post-accept) must see a normal row.
  const { cloudUser, currentUser, currentPrincipal } = useAuth();
  const myEmail = (cloudUser?.email || currentUser?.email || '').trim().toLowerCase();
  // "Me" is the signed-in principal: the agent's Identity on its own box.
  const localUserId = currentPrincipal?.id ?? null;
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
    viewer: { email: myEmail, cloudUserId, localUserId },
    // A row the help desk SOURCE delivered is a staff row: label its state from the desk's side.
    staffView:
      isDeskTicket(conv) ||
      latestMessage?.origin?.kind === 'helpdesk' ||
      firstMessage?.origin?.kind === 'helpdesk' ||
      undefined,
  });
  // Once staff pick a ticket up, later messages reach them through the hub mirror, not the desk source:
  // the message the desk source delivered still names which desk the row belongs to.
  const deskMsg = [latestMessage, firstMessage].find((m) => m?.origin?.kind === 'helpdesk');
  const attributed = deskMsg ?? latestMessage;
  // A thread the hub writes (a Chat API exchange) carries no per-message origin: the conversation's channel names it.
  // The asker's own ticket is not: a Diagnosis reported to a help desk reads as the help desk (its kind chip),
  // not as the channel it started on.
  const asksTicket = facets.kind === 'helpdesk' && facets.ticket?.perspective === 'requester' && !deskMsg;
  const attribution = asksTicket
    ? null
    : attributed?.origin?.kind
      ? attributionFor(attributed.origin, attributed.origin_local, conv.channel_spec)
      : conv.channel
        ? attributionFor({ kind: conv.channel, namespace: '', key: '', url: null }, null, conv.channel_spec)
        : null;
  // Alias kept so the existing invitation-row rendering reads cleanly below.
  const isInvitationRow = facets.isInvitation;

  // Trash does different things depending on ownership — say which one
  // up-front so the tooltip distinguishes it from the (reversible) Archive.
  const { t } = useLingui();
  const deleteKind = deleteKindOf(conv, cloudUserId);
  const deleteLabel =
    deleteKind === 'local'
      ? t`Delete — removes permanently`
      : deleteKind === 'owner'
        ? t`Delete for everyone — permanent`
        : t`Leave conversation`;

  // Which rows a view holds is the page query's answer (`viewClauses`, search by id); a row only hides
  // itself while it cannot render: ``inLoadingState`` keeps one whose FlowMessage hasn't landed from
  // rendering blank.
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
  let isHidden = inLoadingState;
  // The channel filter narrows on the latest message's source; a row whose
  // message is not loaded yet cannot claim a channel, so it waits hidden.
  if (!isHidden && channelMatch) isHidden = !latestMessage || !channelMatch(latestMessage, conv);

  // Gmail-style sender column: comma-joined names of everyone who has
  // participated in the thread, with the latest sender first so the most
  // recent author is the lead name. Deduped case-insensitively.
  // Falls back to the viewer's own name, then ``No members``, when neither the latest message nor any
  // participant has a name; invitation rows always render the canonical
  // ``Invitation`` placeholder so the violet mail-plus icon reads cleanly.
  // MUST run before the `isHidden` early return so the hook order stays
  // stable across visibility flips (Rules of Hooks).
  const participantNames = useMemo(() => {
    if (isInvitationRow) {
      const inviter = (firstMessage?.sender_name || '').trim();
      return [inviter || t`Invitation`];
    }
    // The viewer's own name goes last: the column is short, and the others are who the thread is with.
    const others: string[] = [];
    const own: string[] = [];
    const seen = new Set<string>();
    const pushName = (raw: string | null | undefined, mine: boolean) => {
      const trimmed = (raw || '').trim();
      if (!trimmed) return;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) return;
      (mine ? own : others).push(trimmed);
      seen.add(key);
    };
    const viewer = { email: myEmail, cloudUserId, localUserId };
    const sentByMe = (m: FlowMessage | null | undefined) => !!m && authoredBy(senderOf(m), [cloudUserId, localUserId]);
    pushName(latestMessage?.sender_name, sentByMe(latestMessage));
    if (conv.isChannel) {
      // A channel's people are on the channel, not on the Flowpad roster: whoever opened it (the person,
      // usually) beside whoever spoke last (often the answering agent).
      pushName(firstMessage?.sender_name, sentByMe(firstMessage));
    } else {
      for (const p of conv.members ?? []) {
        const email = (p?.email || '').trim().toLowerCase();
        pushName(personName(p), isViewer(p?.user_id, viewer) || (!!myEmail && email === myEmail));
      }
    }
    const names = [...others, ...own];
    if (names.length > 0) return names;
    // A conversation only the viewer is in (a private Diagnosis, a note to self) is theirs: name them, as the
    // conversation itself does, rather than "Unknown".
    const selfName = currentPrincipal?.name || cloudUser?.name;
    const self = selfName || myEmail ? personName({ name: selfName, email: myEmail }) : '';
    return [self || t`No members`];
  }, [
    currentPrincipal?.name,
    cloudUser?.name,
    isInvitationRow,
    firstMessage,
    latestMessage,
    conv.isChannel,
    conv.members,
    cloudUserId,
    localUserId,
    myEmail,
    t,
  ]);

  const senderLabel = participantNames.join(', ');
  // The stream inbox subject is the conversation's own user-set / hub-synced title
  // (NewConversationDialog at creation; carried in the bundle on cross-user
  // send). A task that happens to sit in the conversation's shared context is
  // there to drive cwd/project_root and the task-gated chips — it is NOT a
  // title source, so it must not feed the subject. Fall back to the email-style
  // "(no subject)" placeholder only when there's no title. The snippet (latest
  // message preview) still renders after it.
  const subject = isInvitationRow
    ? t`You've been invited to a conversation`
    : conv.title?.trim() || (conv.carries_invite ? sharedSubject(t, latestMessage?.invite) : t`(no subject)`);
  // ``FlowMessage.text`` is typed string but older rows in the local DB can
  // hold non-string payloads (object-shaped values from earlier schema
  // iterations); ``?.replace`` would TypeError on those. Coerce first.
  const snippetMessage = isInvitationRow ? firstMessage : latestMessage;
  // A message with no text is named by what it carries.
  const snippet = markdownToPlain(String(snippetMessage?.text || attachmentSummary(snippetMessage) || ''));
  // Column filters match what the row shows, so they run on the rendered text.
  if (!isHidden && columnFilter) {
    isHidden = !matchesColumnFilter(columnFilter, {
      senders: senderLabel,
      subjectLine: `${subject} ${snippet}`,
      updated: conv.updated_date,
    });
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

  if (isHidden) return null;

  const count = pointers.length || conv.message_count || 0;
  const fileCount = conv.attachment_count ?? 0;
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
    // links, banner clicks, and Stream Inbox clicks all behave identically and the
    // backend reconciles StreamInboxManager.unread after the mutation.
    if (onOpenConversation) onOpenConversation(conv.id);
    else navigation.openDockOnThisPage(DockPointer.forConversation(conv.id, { agentId }));
  };

  const handleAccept = async () => {
    if (!invitationId) return;
    setAccepting(true);
    try {
      await answerInvitation(invitationId, 'accept');
    } catch (e) {
      if (isInvitationGoneError(e)) {
        notify.warning({ title: t`Invitation no longer valid`, id: 'membership-invite' });
      } else {
        console.error('[StreamInboxView] acceptInvitation failed', e);
      }
    } finally {
      setAccepting(false);
    }
  };

  return (
    <div
      ref={rowRef}
      data-testid="stream-inbox-conversation-row"
      data-conversation-id={conv.id ?? ''}
      data-focused={isFocused ? 'true' : 'false'}
      data-unread={isUnread ? 'true' : 'false'}
      data-ended={conv.ended_at ? 'true' : 'false'}
      data-kind={isInvitationRow ? 'invitation' : 'user'}
      onClick={handleClick}
      data-selected={selected ? 'true' : 'false'}
      className={`group relative flex h-9 ${
        isInvitationRow && !selectMode ? 'cursor-default' : 'cursor-pointer'
      } items-center gap-3 border-b border-border/40 px-3 text-sm transition-colors hover:bg-accent/40 hover:shadow-sm ${
        selected ? 'bg-primary/10' : isFocused ? 'bg-primary/10' : ''
      } ${isUnread ? 'bg-background' : 'bg-muted/20'} ${isInvitationRow ? 'border-l-2 border-s-violet-500/60' : ''} ${conv.ended_at ? 'opacity-60' : ''}`}
    >
      {/* Multi-select tick. Stops propagation so ticking a row never opens it.
          Always visible per line with a readable border — a dimmed one (/30 at
          50% opacity) vanished on the dark rows; brightens on hover, fills when ticked. */}
      <span onClick={(e) => e.stopPropagation()} className="flex shrink-0 items-center">
        <Checkbox
          checked={!!selected}
          onCheckedChange={() => convId && onToggleSelect?.(convId)}
          aria-label={t`Select conversation`}
          data-testid="stream-inbox-row-select"
          className="h-3.5 w-3.5 border-muted-foreground transition-colors hover:border-foreground data-[state=checked]:border-primary"
        />
      </span>
      <span
        data-testid="stream-inbox-row-sender"
        // ``title`` doubles as the trim-overflow tooltip. Browsers only show
        // the native tooltip when the user hovers, so always setting it is
        // cheap; when the visible label already shows the full list, the
        // hover-text repeats it harmlessly.
        title={senderLabel}
        className={`flex ${FROM_WIDTH_CLASS} shrink-0 items-center gap-1 ${isUnread ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}
      >
        {isInvitationRow && <MailPlus className="h-3.5 w-3.5 flex-shrink-0 text-violet-500" aria-label="invitation" />}
        <span className="min-w-0 flex-1 truncate">{senderLabel}</span>
        {!isInvitationRow && count > 1 && (
          <span className="ms-1 shrink-0 font-normal text-muted-foreground">({count})</span>
        )}
        {!isInvitationRow && convId && fileCount > 0 && (
          <ConversationAttachmentsButton conversationId={convId} count={fileCount} />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate" data-testid="stream-inbox-row-subject-line">
        {/* Channel conversations carry exactly one compact source chip; hub
            rows have no origin and render none — absence means "ours". A
            source-backed ticket wears the source chip (the desk's name) instead of
            the kind chip — that is for the requester's side, where no source
            exists — and still wears its state chip (waiting / picked / closed). */}
        <CategoryChips facets={attribution ? { ...facets, kind: 'direct' } : facets} className="me-1" />
        {automationMark && (
          // An automation ran on a message in here: ⚡ + who. Opens that session; the row opens the conversation.
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              navigation.openDockOnThisPage(DockPointer.forProcessRuns({ run: automationMark.id }));
            }}
            className={cn(
              'me-1 inline-flex items-center',
              COMPACT,
              isProcessLive(automationMark.status)
                ? 'border-sky-500/50 bg-sky-500/15 text-sky-700 dark:text-sky-300'
                : isProcessFailed(automationMark.status)
                  ? 'border-dashed border-border text-muted-foreground'
                  : 'border-emerald-500/50 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
            )}
            title={automationMark.name ?? undefined}
            data-testid="stream-inbox-row-automation"
            data-status={String(automationMark.status ?? '')}
          >
            <Zap className="h-2.5 w-2.5" aria-hidden />
            {automationMark.name}
          </button>
        )}
        <SourceChip attribution={attribution} className="me-1" />
        <ConversationMarkChips marks={conv.marks} />
        {/* Accepted is the normal ending — only an unanswered or refused share earns a chip. */}
        {latestMessage?.invite && latestMessage.invite.state !== 'accepted' && (
          <InviteStateChip
            state={latestMessage.invite.state}
            resolvedAt={latestMessage.invite.resolved_at}
            className="me-1"
          />
        )}
        {/* dir="auto" isolates each part: an RTL subject + RTL snippet would otherwise
            merge into one RTL run that pushes the subject past the truncated edge. */}
        <span dir="auto" className={isUnread ? 'font-semibold text-foreground' : 'text-foreground/80'}>
          {subject}
        </span>
        {snippet && (
          <>
            <span className="mx-1 text-muted-foreground">—</span>
            <span dir="auto" className="text-muted-foreground">
              {snippet}
            </span>
          </>
        )}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground transition-opacity group-hover:opacity-0 pointer-coarse:!opacity-100">
        {time}
        {ago && <span className="ms-1.5 text-muted-foreground/70 max-md:hidden">· {ago}</span>}
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
          onDelete: () => conv.id && onRequestDelete({ kind: deleteKind, conversationId: conv.id }),
        }).filter((spec) => desktopStreamInbox || !PER_MACHINE_ROW_ACTIONS.has(spec.key))}
      />
    </div>
  );
});

/** A callback whose identity never changes and that always calls the latest `fn`. */
function useStableCallback<A extends unknown[]>(fn: (...args: A) => unknown): (...args: A) => void {
  const latest = useRef(fn);
  latest.current = fn;
  return useCallback((...args: A) => void latest.current(...args), []);
}

const columnInputClass =
  'h-7 shrink-0 rounded-md border border-border/60 bg-background px-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring';

// The From column's width is one CSS variable on the list, so dragging the spacer resizes the
// header filter and every row without re-rendering a row.
const FROM_WIDTH_VAR = '--stream-inbox-from-width';
const FROM_WIDTH_CLASS = 'w-[var(--stream-inbox-from-width)] max-md:w-24';
const FROM_WIDTH_KEY = 'flowpad.stream-inbox.from-width';
const FROM_WIDTH_DEFAULT = 176;
const FROM_WIDTH_MIN = 96;
const FROM_WIDTH_MAX = 640;

function readFromWidth(): number {
  try {
    const stored = Number(window.localStorage.getItem(FROM_WIDTH_KEY));
    if (stored >= FROM_WIDTH_MIN && stored <= FROM_WIDTH_MAX) return stored;
  } catch {
    // Storage is unavailable (private window): the default width stands.
  }
  return FROM_WIDTH_DEFAULT;
}

// ── StreamInboxView ───────────────────────────────────────────────────────────────

export function StreamInboxView({
  agentId,
  sourceId,
  embedded = false,
  initialChannel,
  emptyHint,
  onOpenConversation,
}: {
  agentId?: string;
  onOpenConversation?: (conversationId: string) => void;
  /** One data source's conversations only (a source's page) — the same live list, backend-filtered. */
  sourceId?: string;
  /** Inside another page: no stream-inbox-wide verbs (New, New group, Mark all read, Archive all), no channel bar, no
   *  membership invitations — those belong to an owner's stream inbox, not to one source. */
  embedded?: boolean;
  /** The channel mark (`channelKeyOf` key) the list opens narrowed to — an agent's stream inbox opens on its email.
   *  The mark's × clears it like any filter; remount (key the view) to open on another. */
  initialChannel?: string;
  /** What the empty list says instead of offering channels to connect (an agent whose mailbox admits nobody yet). */
  emptyHint?: ReactNode;
} = {}) {
  const { t } = useLingui();
  const [fetching, setFetching] = useState(false);
  // 'all' (default) shows active conversations; 'archived' shows only
  // rows whose ``archived_at`` is set and not yet revived by newer activity.
  // "Delete all" is gated behind the 'archived' view — a destructive op only
  // exposed once the user has explicitly archived rows.
  // URL-owned (`?view=`), so navigation back to the stream inbox restores the pill.
  const { navigation, currentDock } = useDockNavigation();
  const viewMode: StreamInboxViewMode = currentDock?.streamInboxView ?? 'all';
  // Read state, archive, search and channel pulls are this machine's; the hub page offers none of them.
  const desktopStreamInbox = !isHubOnly();
  // Set of conv ids whose row currently chose to render. Driven by row-level
  // `onVisibilityChange` callbacks so the header badge and empty-state both
  // reflect exactly what the user sees (rows hide themselves when their latest
  // FlowMessage is archived or hasn't materialised yet).
  const [visibleIds, setVisibleIds] = useState<Set<string>>(new Set());
  // Rendered pending membership-invite rows (reported by MembershipInvitations)
  // — only gates the empty state; the unread NUMBER is backend-owned.
  const [membershipPendingCount, setMembershipPendingCount] = useState(0);
  const rowRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());
  const { cloudUser } = useAuth();
  // Whose channels the header line shows: the agent's on an agent stream inbox, else
  // the local user's — absent until that typeid is known, so no empty bar flashes.
  // `localUser.id`, not `userTypeId`: that alias resolves to the `@local` pointer,
  // and rows carry the user's real id.
  const { localUser } = useContext();
  const localUserId = localUser?.id;
  // The channel filter: source ids the list is narrowed to. Local like the text
  // search, and empty means everything.
  const channelsOwner = useMemo(() => channelsOwnerFor(agentId, localUserId), [agentId, localUserId]);
  const {
    rows: ownerChannels,
    specFor,
    offers: channelOffers,
    builtInOffered,
    loading: channelsLoading,
  } = useAttachedChannels(channelsOwner);
  const { attributionFor: attributionForOrigin } = useChannelAttribution();
  const attributionFor = useCallback(
    // The message's own source (origin_local) names WHICH source delivered it: two help desks share
    // the `helpdesk` channel, so the channel alone would name the first desk for every ticket.
    (
      origin: FlowMessage['origin'],
      originLocal?: FlowMessage['origin_local'],
      channelSpec?: Conversation['channel_spec'],
    ) => attributionForOrigin(origin, originLocal ?? null, channelSpec),
    [attributionForOrigin],
  );
  // The picked channels live in the URL (`?channel=`), like the view and the search: Back, reload and
  // a shared link land on the same pick. `initialChannel` is the default when the URL names none.
  const rawChannels = currentDock?.options?.[STREAM_INBOX_CHANNEL_PARAM];
  // With neither, the last pick on this machine is remembered per owner.
  const channelStoreKey = channelsOwner ? `stream-inbox-channels:${channelsOwner.toString()}` : null;
  const channelFilter = useMemo(
    () =>
      new Set(
        currentDock?.streamInboxChannels ?? (initialChannel ? [initialChannel] : readStoredChannels(channelStoreKey)),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the raw option is the pick; the dock object changes on every navigation
    [rawChannels, initialChannel, channelStoreKey],
  );
  const setChannelFilter = useCallback(
    (next: Set<string>) => {
      if (!initialChannel && channelStoreKey) {
        try {
          window.localStorage.setItem(channelStoreKey, JSON.stringify([...next]));
        } catch {
          // Storage is unavailable: the pick holds for this visit only.
        }
      }
      if (currentDock) navigation.openDock(currentDock.withStreamInboxChannels([...next], !!initialChannel));
    },
    [currentDock, navigation, initialChannel, channelStoreKey],
  );
  // The query already narrows to the picked sources; this also hides rows pushed live from other channels.
  const channelMatch = useMemo(
    () =>
      channelFilter.size
        ? (m: FlowMessage, conv: Conversation) => {
            // A built-in channel (Diagnosis) is the conversation's own; a source's is its message's.
            if (conv.channel && channelFilter.has(conv.channel)) return true;
            const source = sourceForOrigin(ownerChannels, m.origin, m.origin_local);
            if (!conv.channel && !source && !conv.channel_source_id) return channelFilter.has(FLOWPAD_CHANNEL);
            return !!source && channelFilter.has(channelKeyOf(source));
          }
        : undefined,
    [channelFilter, ownerChannels],
  );
  // The list filters on the URL's value; the boxes hold the draft.
  const urlColumns = currentDock?.streamInboxColumns ?? NO_COLUMN_FILTER;
  const columnFilter = useMemo<StreamInboxColumns>(
    () => ({ from: urlColumns.from, subject: urlColumns.subject, date: urlColumns.date }),
    [urlColumns.from, urlColumns.subject, urlColumns.date],
  );
  const [columnInput, setColumnInput] = useUrlDraft(
    columnFilter,
    (next) => currentDock && navigation.openDock(currentDock.withStreamInboxColumns(next)),
    sameColumns,
  );
  const [fromWidth, setFromWidth] = useState(readFromWidth);
  const listRef = useRef<HTMLDivElement | null>(null);
  const commitFromWidth = useCallback((width: number) => {
    setFromWidth(width);
    try {
      window.localStorage.setItem(FROM_WIDTH_KEY, String(width));
    } catch {
      // Storage is unavailable: the width holds for this visit only.
    }
  }, []);
  // A drag paints through the CSS variable alone; state and storage are written once, on release.
  const startFromResize = useCallback(
    (e: ReactPointerEvent<HTMLSpanElement>) => {
      e.preventDefault();
      const startX = e.clientX;
      // In a right-to-left layout the column grows as the pointer moves left.
      const sign = getComputedStyle(e.currentTarget).direction === 'rtl' ? -1 : 1;
      let width = fromWidth;
      const onMove = (ev: PointerEvent) => {
        const next = fromWidth + sign * (ev.clientX - startX);
        width = Math.round(Math.min(FROM_WIDTH_MAX, Math.max(FROM_WIDTH_MIN, next)));
        listRef.current?.style.setProperty(FROM_WIDTH_VAR, `${width}px`);
      };
      const onEnd = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onEnd);
        window.removeEventListener('pointercancel', onEnd);
        commitFromWidth(width);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onEnd);
      window.addEventListener('pointercancel', onEnd);
    },
    [fromWidth, commitFromWidth],
  );
  const columnFilterActive = isColumnFilterActive(columnFilter);
  // The rail's Stream Inbox icon: back to every message, no filter of any kind. Only the user's own
  // stream listens; a fresh mount already starts unfiltered.
  useUiActionRequest(embedded || agentId || sourceId ? [] : ['stream-inbox.reset'], () => {
    if (
      currentDock &&
      (currentDock.streamInboxView !== 'all' ||
        currentDock.streamInboxSearch ||
        currentDock.pageBefore ||
        currentDock.streamInboxChannels !== null ||
        columnFilterActive)
    )
      navigation.openDock(
        currentDock
          .withStreamInboxFilters({ view: 'all', search: '' })
          .withStreamInboxChannels([])
          .withStreamInboxColumns(NO_COLUMN_FILTER),
      );
    setColumnInput(NO_COLUMN_FILTER);
    setSelectedIds(new Set());
  });
  const setColumn = useCallback(
    <K extends keyof StreamInboxColumns>(key: K, value: StreamInboxColumns[K]) =>
      setColumnInput((cur) => ({ ...cur, [key]: value })),
    [setColumnInput],
  );
  const cloudUserId = cloudUser?.id ?? null;
  const { connection } = useCloudStatus();
  const hubReachable = connection.status === 'connected' || connection.status === 'verified';

  // Bulk-delete + per-row-delete dialog state.
  const [bulkDialogOpen, setBulkDialogOpen] = useState(false);
  const [showNewConversation, setShowNewConversation] = useState(false);
  const [showContacts, setShowContacts] = useState(false);
  const [rowDelete, setRowDelete] = useState<RowDeleteAction | null>(null);
  // Multi-select: ids of rows ticked for a bulk mark-read/unread/archive/delete.
  // Constrained to currently-visible rows when actions run, so a stale id left
  // over from a view switch can never act on a hidden conversation.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selDeleteOpen, setSelDeleteOpen] = useState(false);

  // Text search over message bodies — server-side, via the `stream-inbox-search`
  // action rather than a `$LIKE` entity query: under the reference model a
  // channel message's body lives on its SourceItem (the FlowMessage row stores
  // `text: ""`), so the backend searches BOTH residences and hands back
  // conversation ids. The URL commit debounces typing; the previous result is held
  // while the next request is in flight so the list doesn't blank.
  // URL-owned (`?q=`).
  const searchQuery = currentDock?.streamInboxSearch ?? '';
  const [searchInput, setSearchInput] = useUrlDraft(
    searchQuery,
    (next) => currentDock && navigation.openDock(currentDock.withStreamInboxFilters({ search: next })),
  );
  const needle = searchQuery.trim();
  const searchActive = needle !== '';
  const [matchIds, setMatchIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!searchActive) return;
    // `needle` is the URL's, already debounced on its way there.
    let stale = false;
    void searchStreamInbox(needle, agentId).then((ids) => {
      if (!stale) setMatchIds(ids);
    });
    return () => {
      stale = true;
    };
  }, [agentId, needle, searchActive]);

  // Scoped by the backend: the query names the owner, so an agent's stream inbox and the
  // user's never load each other's rows. Owned-by strings, not TypeId instances, key the memo:
  // `channelsOwner` is rebuilt whenever its inputs change identity, and a fresh request re-subscribes.
  // One PAGE, not the whole stream inbox: the view's latest N (`before` null = now, live) or the N older
  // than the dock URL's `before`. A body search lists its hits instead.
  const pageBefore = currentDock?.pageBefore ?? null;
  const ownerKey = channelsOwner?.toString() ?? '';
  // The channel marks narrow the QUERY to the picked marks' sources: a page is then rows of those
  // sources, and Older / Newer page through them, rather than the latest page thinned out in the browser.
  const pickedSources = useMemo(
    () =>
      channelFilter.size
        ? ownerChannels.filter((s) => s.id && channelFilter.has(channelKeyOf(s))).map((s) => s.id as string)
        : [],
    [ownerChannels, channelFilter],
  );
  const pickedChannels = useMemo(() => BUILT_IN_CHANNELS.filter((c) => channelFilter.has(c)), [channelFilter]);
  // a refreshed channel list with the same picks keeps the scope
  const pickedKey = [...pickedSources].sort().join(',') + '|' + pickedChannels.join(',');
  const scope = useMemo<ConversationScope | null>(() => {
    if (sourceId) return { sourceId };
    if (!channelsOwner) return null;
    if (!pickedSources.length && !pickedChannels.length) return { owner: channelsOwner };
    return { owner: channelsOwner, sourceIds: pickedSources, channels: pickedChannels };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the owner's and the picks' string forms
  }, [ownerKey, sourceId, pickedKey]);
  const request = useMemo(() => {
    if (!scope) return null;
    if (searchActive) return conversationsByIdsRequest(scope, [...matchIds]);
    return conversationsPageRequest(scope, viewMode, pageBefore);
  }, [scope, searchActive, matchIds, viewMode, pageBefore]);
  const idleRequest = useMemo(() => new QueryRequest({ type: Conversation.type, name: 'stream-inbox:idle' }), []);
  const {
    data: conversations = [],
    refetch,
    isLoading,
    isSuccess,
  } = useEntitiesQuery<Conversation>(request ?? idleRequest, { enabled: request !== null });

  // Only the FIRST load gets the full-screen "Loading…" state. Every
  // ``refetch()`` (manual hub-pull, mark-read, archive, …) flips ``isLoading``
  // back to true while KEEPING the previous ``data`` — so gating the row list
  // on raw ``isLoading`` blanks the whole list to the spinner and back on every
  // refetch, which is the on-open flicker. Once we've loaded successfully once,
  // a background refetch keeps the existing rows on screen.
  const hasLoadedOnce = useRef(false);
  if (isSuccess) hasLoadedOnce.current = true;
  const initialLoading = (isLoading || request === null) && !hasLoadedOnce.current;

  const sorted = useMemo(() => {
    // Sorted here too: a live push appends a newly matching row without re-sorting or trimming
    // the page, so the page is cut back to its size after the sort.
    const list = [...conversations];
    list.sort(compareConversationsByRecency);
    return list.slice(0, STREAM_INBOX_PAGE_SIZE);
  }, [conversations]);

  // ── Batch-hydrate the per-row first+latest FlowMessages (X2) ────────────────
  // Each ``ConversationListRow`` resolves its first + latest FlowMessage by id
  // to render the sender/snippet/unread cues. Left to itself every row would
  // fire its own ``getByTypeId`` GET (N+1 — 73 GETs for 73 conversations). We
  // instead collect every first+latest pointer id across the *visible* list and
  // warm the DataManager cache with ONE ``$IN`` query; the rows' ``useEntity``
  // calls then hit ``getByTypeIdFromCache`` and issue no network at all. The
  // single ``watchQuery`` subscription replaces the would-be per-row watches.
  const flowMessageIds = useMemo(() => conversationRowMessageIds(sorted), [sorted]);
  // The same batch also yields the messages here, to discover which first-messages
  // carry an invitation context — those ids drive a SECOND batch ``$IN`` so the
  // per-row ``useEntity<Invitation>`` also resolves from cache instead of one GET each.
  const { data: batchedMessages, settled: messagesSettled } = useEntityBatchState<FlowMessage>(
    FlowMessage.type,
    flowMessageIds,
  );
  // The rows mount once their messages are in the cache: a row stays hidden until its latest
  // message resolves anyway, and mounting before the batch rendered every row twice more as its
  // first and latest messages arrived. Latched, so a later batch (a new message) never unmounts them.
  const rowsReady = useRef(false);
  if (messagesSettled && !initialLoading) rowsReady.current = true;
  // The sessions automations started on the visible conversations' messages — one query, the newest per row.
  const conversationIds = useMemo(() => sorted.map((c) => c.id ?? '').filter(Boolean), [sorted]);
  const automationMarks = useConversationAutomationMarks(conversationIds);
  const invitationIds = useMemo(() => {
    const ids = new Set<string>();
    for (const msg of batchedMessages) {
      const tid = msg.firstContextOfType?.('invitation');
      if (tid?.id) ids.add(tid.id);
    }
    return [...ids];
  }, [batchedMessages]);

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

  // Unread: backend-owned (StreamInboxManager.unread) — the rail badge's number, so the two always
  // agree. It counts the user's own stream inbox, so an agent's or a source's view does not use it.
  const { unread: streamInboxUnread } = useStreamInboxManager();
  const ownStreamInbox = !agentId && !sourceId;

  // Refresh = read every channel of this stream inbox NOW (the same `pullNow` a source's own ↻ runs), then the list.
  // A channel waiting on setup or paused is not read; it says so on its own strip.
  const handleRefresh = useCallback(async () => {
    setFetching(true);
    try {
      // Pulling the channels and the hub into the local copy is the desktop's; the hub page reads the hub.
      if (desktopStreamInbox) {
        const runnable = ownerChannels.filter((source) => source.status === 'active' || source.status === 'new');
        const answers = await Promise.all(
          runnable.map(async (source) => ({ name: source.name || source.provider, ...(await pullNow(source)) })),
        );
        await fetchConversations(agentId);
        if (answers.length) {
          const line = answers.map((a) => `${a.name}: ${a.text}`).join(' · ');
          if (answers.every((a) => a.ok)) notify.success({ title: t`Checked for new messages`, message: line });
          else notify.error({ title: t`Some channels could not be checked`, message: line });
        }
      }
      void refetch();
    } finally {
      setFetching(false);
    }
  }, [agentId, desktopStreamInbox, refetch, ownerChannels, t]);

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

  // The rows get callbacks that never change: an inline arrow per render was a new prop on every
  // row, so the memoized row re-rendered anyway.
  const rowArchive = useStableCallback(handleArchive);
  const rowUnarchive = useStableCallback(handleUnarchive);
  const rowToggleRead = useStableCallback(handleToggleRead);
  const setRowRef = useCallback((convId: string, el: HTMLDivElement | null) => {
    rowRefs.current.set(convId, el);
  }, []);

  const handleMarkAllRead = useCallback(async () => {
    // No optimistic zero: the backend reconciles StreamInboxManager.unread after the
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

  // Compute the bulk-delete bucket breakdown from the archived
  // conversations on this page. Drives the BulkConfirmDialog summary and the
  // hub-reachability gate. Mirrors the server-side classification in
  // ``handle_conversation_delete_archived``.
  const archivedConvs = useMemo(() => conversations.filter((c) => c.archived_at), [conversations]);
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
          continue;
        }
        const kind = deleteKindOf(c, cloudUserId);
        if (kind === 'local') localCount += 1;
        else if (kind === 'owner') ownerCount += 1;
        else nonOwnerCount += 1;
      }
      return { ownerCount, nonOwnerCount, invitationCount, localCount };
    },
    [cloudUserId, localUserId, seemsInvitationConv],
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
    return c.latestMessagePointer?.id ?? null;
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
        } else {
          const kind = deleteKindOf(c, cloudUserId);
          const scope = agentId ? { agent_id: agentId } : {};
          if (kind === 'leave') await leaveConversation({ conversation_id: c.id, ...scope });
          else
            await deleteConversation({
              conversation_id: c.id,
              mode: kind === 'local' ? 'local' : 'delete_for_all',
              ...scope,
            });
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
  }, [agentId, selectedConvs, seemsInvitationConv, cloudUserId, localUserId, clearSelection, refetch, t]);

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
        await answerInvitation(rowDelete.invitationId, 'decline');
        notify.success({ title: t`Invitation declined` });
      } else if (rowDelete.kind === 'owner') {
        await deleteConversation({
          conversation_id: rowDelete.conversationId,
          mode: 'delete_for_all',
          ...(agentId ? { agent_id: agentId } : {}),
        });
        notify.success({ title: t`Conversation deleted` });
      } else if (rowDelete.kind === 'leave') {
        await leaveConversation({
          conversation_id: rowDelete.conversationId,
          ...(agentId ? { agent_id: agentId } : {}),
        });
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
        await dismissConversation({
          conversation_id: action.conversationId,
          ...(agentId ? { agent_id: agentId } : {}),
        });
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

  const setView = useCallback(
    (next: StreamInboxViewMode) => {
      if (next === viewMode || !currentDock) return;
      // Visible-ids tracks the previous mode's rows; reset so the count
      // badge doesn't flash stale during the swap. Selection is per-view, so
      // drop it too — carrying ticks across modes would act on hidden rows.
      setVisibleIds(new Set());
      setSelectedIds(new Set());
      // A page is a page of ONE view: another view starts at now.
      navigation.openDock(currentDock.withStreamInboxFilters({ view: next }));
    },
    [viewMode, currentDock, navigation],
  );

  const inArchivedView = viewMode === 'archived';
  const inUnreadView = viewMode === 'unread';
  const inInvitesView = viewMode === 'invites';
  // Segmented view pill — All | Unread | Archived. Active mode is filled,
  // inactive is ghost.
  const renderViewPill = (mode: StreamInboxViewMode, label: string, Icon: typeof InboxIcon) => {
    const active = viewMode === mode;
    // Unread in the user's own Stream Inbox: the backend total, on the pill whether or not it is active.
    // Otherwise the rows on this page — a full page holds more than it shows, so it reads "N+".
    let badge: string | null = null;
    if (mode === 'unread' && ownStreamInbox) badge = streamInboxUnread > 0 ? String(streamInboxUnread) : null;
    else if (active && visibleCount > 0)
      badge = visibleCount >= STREAM_INBOX_PAGE_SIZE ? `${STREAM_INBOX_PAGE_SIZE}+` : String(visibleCount);
    return (
      <button
        type="button"
        onClick={() => setView(mode)}
        className={`flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium transition-colors ${
          active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
        }`}
        data-testid={`stream-inbox-view-${mode}`}
        aria-pressed={active}
      >
        <Icon className="h-3.5 w-3.5" />
        <span>{label}</span>
        {badge !== null && (
          // Fixed min-width + tabular figures: the badge keeps the same box up
          // to three digits, so a growing count doesn't reflow the search input
          // and the buttons to its right.
          <span className="inline-block min-w-[30px] rounded bg-muted px-1.5 py-0.5 text-center text-[10px] tabular-nums text-muted-foreground">
            {badge}
          </span>
        )}
      </button>
    );
  };

  // List mode
  // The list's main verbs get a row of their own; the channel buttons sit at its far end. Where that
  // row is not drawn (an agent's StreamInbox, an embedded list, a selection in progress) they fall back to the filter row.
  const hasTopRow = !agentId && !embedded && selectedCount === 0;
  const invitesChip = !agentId && !embedded && (
    <InvitesChannelChip
      active={inInvitesView}
      pending={membershipPendingCount}
      onClick={() => setView(inInvitesView ? 'all' : 'invites')}
    />
  );
  const channelButtons = (
    <>
      {channelsOwner && !embedded ? (
        <AttachedChannelsBar
          owner={channelsOwner}
          rows={ownerChannels}
          offers={channelOffers}
          builtInOffered={builtInOffered}
          specFor={specFor}
          selected={channelFilter}
          onSelectedChange={setChannelFilter}
          className="shrink-0"
          leading={invitesChip}
        />
      ) : (
        invitesChip
      )}
    </>
  );

  return (
    <div className="relative flex h-full flex-col">
      {!cloudUser && (
        <LoginRequiredOverlay
          description={t`Sign in to your Flowpad Cloud account to view your stream inbox and conversations.`}
        />
      )}
      {/* The list's main verbs get a row of their own, full-size, so they can't be missed. */}
      {hasTopRow && (
        <div
          className="flex shrink-0 items-center gap-2 border-b px-3 py-2 max-md:flex-wrap"
          data-testid="stream-inbox-primary-actions"
        >
          <Button
            onClick={() => setShowNewConversation(true)}
            data-testid="stream-inbox-new-conversation-button"
            title={t`Start a new conversation`}
          >
            <SquarePen />
            <Trans>New conversation</Trans>
          </Button>
          {desktopStreamInbox && (
            <>
              <ProjectUploadMessageButton variant="outline" size="default" />
              <Button
                variant="outline"
                onClick={() => setShowContacts(true)}
                data-testid="stream-inbox-contacts-button"
              >
                <BookUser />
                <Trans>Contacts</Trans>
              </Button>
            </>
          )}
          <div className="ms-auto flex min-w-0 items-center gap-2">{channelButtons}</div>
        </div>
      )}
      <div className="flex shrink-0 items-center border-b px-3 py-1.5 max-md:flex-wrap max-md:gap-y-1">
        {/* Selection mode takes over the whole toolbar: the view pills, search and
            New buttons act on the list, not on the ticked rows, so they step aside
            until the selection is closed (X). */}
        {selectedCount > 0 ? (
          <div className="flex flex-1 items-center gap-1" data-testid="stream-inbox-selection-bar">
            <span className="me-1 text-xs text-muted-foreground" data-testid="stream-inbox-selection-count">
              <Trans>{selectedCount} selected</Trans>
            </span>
            {desktopStreamInbox && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => void handleBulkMarkRead(true)}
                  data-testid="stream-inbox-selection-mark-read"
                >
                  <MailOpen className="me-1 h-3.5 w-3.5" />
                  <Trans>Read</Trans>
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => void handleBulkMarkRead(false)}
                  data-testid="stream-inbox-selection-mark-unread"
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
                    data-testid="stream-inbox-selection-archive"
                  >
                    <Archive className="me-1 h-3.5 w-3.5" />
                    <Trans>Archive</Trans>
                  </Button>
                )}
              </>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => void handleBulkDelete()}
              data-testid="stream-inbox-selection-delete"
            >
              <Trash2 className="me-1 h-3.5 w-3.5" />
              <Trans>Delete</Trans>
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="ms-auto h-7 w-7"
              onClick={clearSelection}
              title={t`Clear selection`}
              data-testid="stream-inbox-selection-clear"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        ) : (
          <>
            {/* LEFT — view selector. flex-1 here + on RIGHT keeps the CENTER truly centered. */}
            <div className="flex flex-1 items-center max-md:flex-wrap max-md:gap-y-1">
              <div
                className="flex items-center gap-0.5 rounded-md bg-muted/40 p-0.5"
                role="tablist"
                aria-label={t`Stream inbox view`}
                data-testid="stream-inbox-view-bar"
              >
                {renderViewPill('all', t`All`, InboxIcon)}
                {desktopStreamInbox && (
                  <>
                    {renderViewPill('unread', t`Unread`, MailPlus)}
                    {renderViewPill('archived', t`Archived`, Archive)}
                  </>
                )}
              </div>
              {/* Text search — filters the list below to conversations whose
                  messages contain the query, spanning archived rows. */}
              {desktopStreamInbox && (
                <div className="relative ms-2 flex items-center max-md:ms-0 max-md:w-full">
                  <Search className="pointer-events-none absolute left-2 h-3.5 w-3.5 text-muted-foreground" />
                  <input
                    type="text"
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                    placeholder={t`Search messages`}
                    className="h-7 w-44 rounded-md border border-border/60 bg-background pe-6 ps-7 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring max-md:h-9 max-md:w-full"
                    data-testid="stream-inbox-search-input"
                    aria-label={t`Search messages`}
                  />
                  {searchActive && (
                    <button
                      type="button"
                      onClick={() => {
                        setSearchInput('');
                        if (currentDock) navigation.openDock(currentDock.withStreamInboxFilters({ search: '' }));
                      }}
                      className="absolute right-1.5 rounded p-0.5 text-muted-foreground hover:text-foreground"
                      aria-label={t`Clear search`}
                      data-testid="stream-inbox-search-clear"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>
              )}
            </div>
            {/* RIGHT — actions for the current view */}
            <div className="flex flex-1 items-center justify-end gap-1" data-testid="stream-inbox-action-bar">
              <>
                {desktopStreamInbox && !inArchivedView && !embedded && (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => void handleMarkAllRead()}
                      disabled={isLoading || visibleCount === 0}
                    >
                      <Trans>Mark all read</Trans>
                    </Button>
                    {/* Archive all archives every conversation regardless of read state;
                    hide it in the Archived view where it makes no sense. */}
                    {!inUnreadView && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => void handleArchiveAll()}
                        disabled={isLoading || visibleCount === 0}
                        data-testid="stream-inbox-archive-all-button"
                      >
                        <Trans>Archive all</Trans>
                      </Button>
                    )}
                  </>
                )}
                {inArchivedView && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => void handleDeleteArchived()}
                    disabled={isLoading || visibleCount === 0}
                    data-testid="stream-inbox-delete-archived-button"
                  >
                    <Trash2 className="me-1 h-3.5 w-3.5" />
                    <Trans>Delete all</Trans>
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => void handleRefresh()}
                  // A press before the channels load would read none of them, silently.
                  disabled={fetching || channelsLoading}
                  title={t`Check for new messages`}
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${fetching ? 'animate-spin' : ''}`} />
                </Button>
              </>
            </div>
          </>
        )}
      </div>

      <div
        ref={listRef}
        className="flex-1 overflow-y-auto"
        style={{ [FROM_WIDTH_VAR]: `${fromWidth}px` } as CSSProperties}
      >
        {/* The header line: select-all, then one filter per row column (From over
            the sender, Subject over the subject line, Date over the time), then the
            owner's attached channels on the right. Rendered even with no
            conversations — the channels are how one gets some, and a filter that
            matched nothing must stay on screen to be cleared. The cells share the
            row's px-3 / gap-3 / w-44 so each filter sits over its column. */}
        {!initialLoading && (
          <div
            className="flex min-h-10 items-center gap-3 border-b border-border/40 bg-muted/20 px-3"
            data-testid="stream-inbox-select-all-row"
          >
            <span className="flex w-3.5 shrink-0 items-center">
              {visibleCount > 0 && (
                <Checkbox
                  checked={allVisibleSelected ? true : selectedCount > 0 ? 'indeterminate' : false}
                  onCheckedChange={toggleSelectAll}
                  aria-label={t`Select all conversations`}
                  title={t`Select all`}
                  data-testid="stream-inbox-select-all"
                  className="h-3.5 w-3.5"
                />
              )}
            </span>
            <input
              type="text"
              value={columnInput.from}
              onChange={(e) => setColumn('from', e.target.value)}
              placeholder={t`From`}
              aria-label={t`Filter by sender`}
              className={`${columnInputClass} ${FROM_WIDTH_CLASS}`}
              data-testid="stream-inbox-filter-from"
            />
            {/* The spacer between From and Subject: drag to trade room between the names and the subject.
                Sits in the gap (negative margins) so the columns keep their alignment with the rows. */}
            <span
              role="separator"
              aria-orientation="vertical"
              aria-label={t`Resize the From column`}
              title={t`Drag to resize`}
              onPointerDown={startFromResize}
              onDoubleClick={() => commitFromWidth(FROM_WIDTH_DEFAULT)}
              className="group/spacer -mx-3 flex h-7 w-3 shrink-0 cursor-col-resize touch-none items-center justify-center"
              data-testid="stream-inbox-from-spacer"
            >
              <span className="h-4 w-px bg-border transition-colors group-hover/spacer:bg-foreground" />
            </span>
            <input
              type="text"
              value={columnInput.subject}
              onChange={(e) => setColumn('subject', e.target.value)}
              placeholder={t`Subject`}
              aria-label={t`Filter by subject`}
              className={`${columnInputClass} min-w-0 flex-1`}
              data-testid="stream-inbox-filter-subject"
            />
            <select
              value={columnInput.date}
              onChange={(e) => setColumn('date', e.target.value as StreamInboxDateWindow)}
              aria-label={t`Filter by date`}
              className={columnInputClass}
              data-testid="stream-inbox-filter-date"
            >
              <option value="any">{t`Any time`}</option>
              <option value="today">{t`Today`}</option>
              <option value="7d">{t`Last 7 days`}</option>
              <option value="30d">{t`Last 30 days`}</option>
            </select>
            {columnFilterActive && (
              <button
                type="button"
                onClick={() => setColumnInput(NO_COLUMN_FILTER)}
                className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
                title={t`Clear filters`}
                aria-label={t`Clear filters`}
                data-testid="stream-inbox-filter-clear"
              >
                <X className="h-3 w-3" />
              </button>
            )}
            {!hasTopRow && channelButtons}
          </div>
        )}

        {initialLoading && (
          <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
            <Trans>Loading…</Trans>
          </div>
        )}

        {!initialLoading && visibleCount === 0 && membershipPendingCount === 0 && (
          <div className="flex h-48 flex-col items-center justify-center gap-3 text-muted-foreground">
            <span className="text-sm">
              {searchActive || columnFilterActive
                ? t`No matching conversations`
                : inInvitesView
                  ? t`Nothing has been shared with you yet`
                  : inArchivedView
                    ? t`No archived conversations`
                    : inUnreadView
                      ? t`No unread conversations`
                      : channelFilter.size > 0
                        ? t`No messages from this channel yet`
                        : t`No conversations`}
            </span>
            {/* An owner with no channel connected: the empty list is where connecting one is offered —
                unless the caller knows better what is missing (an allowlist, not a channel). */}
            {!embedded &&
              !inArchivedView &&
              !inUnreadView &&
              !searchActive &&
              !columnFilterActive &&
              (emptyHint ? (
                <span className="text-sm" data-testid="stream-inbox-empty-hint">
                  {emptyHint}
                </span>
              ) : (
                // Narrowed to one channel, the list is empty for want of mail on IT: offering other channels
                // here answers a question nobody asked.
                channelsOwner &&
                channelFilter.size === 0 && <ConnectChannelPrompt owner={channelsOwner} offers={channelOffers} />
              ))}
            {!inArchivedView && !searchActive && !columnFilterActive && (
              <Button variant="outline" size="sm" onClick={() => void handleRefresh()} disabled={fetching}>
                <RefreshCw className={`me-1.5 h-3.5 w-3.5 ${fetching ? 'animate-spin' : ''}`} />
                <Trans>Check for new messages</Trans>
              </Button>
            )}
          </div>
        )}

        {!agentId && !embedded && !inArchivedView && !initialLoading && (
          <MembershipInvitations
            recipientEmail={cloudUser?.email ?? null}
            onPendingCount={setMembershipPendingCount}
            show={inInvitesView ? 'all' : 'pending'}
          />
        )}

        {/* Start the row batches in the layout phase so the rows' own reads wait
            for them instead of each firing a GET (see EntityBatchHydrator). */}
        <EntityBatchHydrator type={Invitation.type} ids={invitationIds} />
        {!initialLoading &&
          rowsReady.current &&
          sorted.map((conv) => (
            <ConversationListRow
              key={conv.id ?? ''}
              conv={conv}
              isFocused={false}
              revision={rowRevision(conv, conv.id ? automationMarks.get(conv.id) : undefined)}
              onArchive={rowArchive}
              onUnarchive={rowUnarchive}
              onToggleRead={rowToggleRead}
              selected={!!conv.id && selectedIds.has(conv.id)}
              onToggleSelect={toggleSelect}
              selectMode={selectedCount > 0}
              onRequestDelete={handleRowDelete}
              cloudUserId={cloudUserId}
              onVisibilityChange={handleRowVisibility}
              channelMatch={channelMatch}
              columnFilter={columnFilterActive ? columnFilter : undefined}
              attributionFor={attributionFor}
              refSetter={setRowRef}
              agentId={agentId}
              onOpenConversation={onOpenConversation}
              automationMark={conv.id ? automationMarks.get(conv.id) : undefined}
            />
          ))}
        {!initialLoading && !searchActive && scope && <StreamInboxPager scope={scope} view={viewMode} rows={sorted} />}
      </div>

      {!agentId && <NewConversationDialog open={showNewConversation} onClose={() => setShowNewConversation(false)} />}

      {!agentId && (
        <ContactsDialog open={showContacts} onOpenChange={setShowContacts} excludeUserId={cloudUser?.id ?? null} />
      )}

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
            description: t`Hidden from your stream inbox`,
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
