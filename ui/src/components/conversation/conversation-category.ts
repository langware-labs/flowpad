import { t } from '@lingui/core/macro';
import type { LucideIcon } from 'lucide-react';
import { Archive, ArchiveRestore, CheckSquare, CircleCheck, Clock, LifeBuoy, Trash2, UserCheck } from 'lucide-react';
import { Conversation, FlowMessage, FlowMessageKind, Invitation, isHelpdeskKind } from '@sdk';
import type { EntityMember } from '@sdk/APIEntity';
import { isClosedConversation } from '@sdk/entities/conversation';
import { authoredBy, senderOf } from '@sdk/models/MessageSender';

// ── Conversation category — the single source of truth ──────────────────────
// The stream inbox "category" is NOT one axis: a conversation can be helpdesk AND
// archived AND unread at once, and two of the axes (unread, invitation) are
// *viewer-relative* — the same thread is an "Accept" row for the recipient and
// a normal row for the sender. So we derive a small facet struct (centralizing
// what StreamInboxView and RecentConversationsStrip each used to derive separately)
// plus a priority-collapsed `primary` for the cases that need one value.
//
// This is derived view-model logic, NOT persisted state — `kind` and
// `archived_at` are the only stored fields; everything else is computed here.

export interface CategoryInputs {
  conv: Conversation;
  /** First message — used only to detect `kind === 'invitation'`. */
  firstMessage?: FlowMessage | null;
  /** Latest message — the unread fallback on a hub runtime only (see `isUnread`). */
  latestMessage?: FlowMessage | null;
  /** Latest pointer ts (from `conversationMessageIds`). Used for the archived
   *  comparison so we don't race the async FlowMessage fetch — the pointer
   *  lands with the conversation entity, the FM entity arrives later. */
  latestPtrTs?: string | null;
  /** Invitation entity off the first message's context (if any). */
  invitation?: Invitation | null;
  /** The local viewer — invitation/ownership/unread are relative to this.
   *  Both ids are needed: a message's `sender_id` is stamped with the cloud
   *  user id when logged in, the local desktop user id otherwise. */
  viewer: { email: string; cloudUserId: string | null; localUserId: string | null };
  /** Force the staff perspective — a row delivered by a help desk SOURCE is staff's by
   *  construction. Omitted: derived from `initiated_by` against the viewer. */
  staffView?: boolean;
  /** Staff user ids in the ticket, from the desk pool row (`picked_up_by`). Supplements
   *  the roster, which a staff-side row may not carry. */
  pickedUpBy?: string[] | null;
  /** The live roster, when the caller holds a fresher one than `conv.members`. */
  members?: EntityMember[] | null;
}

// ── Ticket state — waiting / picked / closed ─────────────────────────────────
// Closed wins (a reply to a closed ticket keeps it closed). Otherwise a ticket is
// picked once someone OTHER than the requester is in it — on a help desk ticket the
// roster is the requester plus the staff who picked it up.

export type TicketState = 'waiting' | 'picked' | 'closed';

export interface TicketStateInputs {
  status?: string | null;
  /** The requester's user id (the hub's `initiated_by`). */
  initiatedBy?: string | null;
  members?: EntityMember[] | null;
  /** Staff ids from the desk pool row, when the caller has one. */
  pickedUpBy?: string[] | null;
}

/** The staff members of a ticket: everyone on the roster who is not the requester. */
export function ticketStaff(inp: TicketStateInputs): EntityMember[] {
  const requester = inp.initiatedBy || null;
  const staff = (inp.members ?? []).filter(
    (m) => !!m?.user_id && m.user_id !== requester && (m.role ?? '').toLowerCase() !== 'owner',
  );
  for (const id of inp.pickedUpBy ?? []) {
    if (id && id !== requester && !staff.some((m) => m.user_id === id)) staff.push({ user_id: id });
  }
  return staff;
}

/** Pure: the state chip a help desk ticket wears. */
export function ticketState(inp: TicketStateInputs): TicketState {
  if (isClosedConversation(inp.status)) return 'closed';
  return ticketStaff(inp).length > 0 ? 'picked' : 'waiting';
}

export interface TicketFacet {
  state: TicketState;
  perspective: 'requester' | 'staff';
  /** Staff view of a picked ticket: `'you'` when the viewer picked it, else the picker's
   *  name (null when the roster names nobody). */
  pickedBy: string | null;
}

/** The desk chip's label from the desk (source) name: "GTM Studio" → "GTM Studio help desk",
 *  "Flowpad Support" → "Flowpad help desk". */
export function deskChipLabel(deskName: string): string {
  const base = deskName
    .trim()
    .replace(/\s+(support|help\s*desk|helpdesk)$/i, '')
    .trim();
  return base ? t`${base} help desk` : t`Help desk`;
}

export interface ConversationFacets {
  kind: 'direct' | 'helpdesk';
  /** Viewer is the pending recipient of an unaccepted invitation. */
  isInvitation: boolean;
  /** `archived_at` is set and not yet revived by newer activity. */
  isArchived: boolean;
  /** Latest RECEIVED message is unread (invitation rows count as unread).
   *  Viewer-relative: a self-sent latest message never makes the row unread. */
  isUnread: boolean;
  /** Help desk tickets only: the waiting / picked / closed state, viewer-relative label inputs. */
  ticket?: TicketFacet;
}

/** Derive the category facets for a conversation row. Pure — no hooks, safe to
 *  call anywhere in a component (it is not a React hook). */
export function conversationFacets(inp: CategoryInputs): ConversationFacets {
  const { conv, firstMessage, latestMessage, latestPtrTs, invitation, viewer } = inp;

  const kind = isHelpdeskKind(conv.kind) ? 'helpdesk' : 'direct';

  // Invitation — viewer-relative. The first message stays `kind === invitation`
  // forever, so the sender (and everyone post-accept) must see a normal row;
  // only the still-pending *recipient* gets the invitation treatment.
  const myEmail = (viewer.email || '').trim().toLowerCase();
  const recipientEmail = (invitation?.recipient_email || '').trim().toLowerCase();
  const isInvitation =
    firstMessage?.kind === FlowMessageKind.INVITATION &&
    !invitation?.accepted &&
    !!myEmail &&
    myEmail === recipientEmail;

  // Archived — `archived_at` stamp, revived when a message newer than the stamp
  // arrives. Compare against the pointer ts (not the FM) to avoid the fetch race.
  const archivedAt = conv.archived_at ? new Date(conv.archived_at).getTime() : null;
  const latestTime = latestPtrTs ? new Date(latestPtrTs).getTime() : 0;
  const isArchived = archivedAt !== null && !Number.isNaN(archivedAt) && latestTime <= archivedAt;

  // Unread — the backend owns it. The desktop stamps `conv.is_unread` from the one
  // rule the badge also counts with (`stream_inbox.conversation_unread_count`: drafts,
  // self-sent and agent replies excluded), so the row renders that answer rather
  // than a second copy of the rule that can drift. A hub runtime has no per-viewer
  // read projection yet (docs/hub-rest-consolidation.md §1): its rows arrive without
  // the field and fall back to the latest message. Invitation rows carry a CTA, so
  // they are unread either way.
  const hubUnread = latestMessage
    ? !latestMessage.is_read && !authoredBy(senderOf(latestMessage), [viewer.cloudUserId, viewer.localUserId])
    : false;
  const isUnread = isInvitation || (conv.is_unread ?? hubUnread);

  let ticket: TicketFacet | undefined;
  if (kind === 'helpdesk' || inp.staffView) {
    const tin: TicketStateInputs = {
      status: conv.status,
      initiatedBy: conv.initiated_by ?? null,
      members: inp.members ?? conv.members ?? [],
      // The hub computes `picked_up_by` on the ticket itself (the requester's roster is masked,
      // so it is the only way their side learns a staffer joined); a pool row may supplement it.
      pickedUpBy: inp.pickedUpBy ?? (conv as { picked_up_by?: string[] | null }).picked_up_by ?? null,
    };
    const state = ticketState(tin);
    const staffView = inp.staffView ?? (!!conv.initiated_by && !isViewer(conv.initiated_by, viewer));
    let pickedBy: string | null = null;
    if (staffView && state !== 'waiting') {
      const staff = ticketStaff(tin);
      const mine = staff.find((m) => isViewer(m.user_id, viewer));
      const other = staff.find((m) => m.name || m.email);
      pickedBy = mine ? 'you' : other?.name || other?.email || null;
    }
    ticket = { state, perspective: staffView ? 'staff' : 'requester', pickedBy };
  }

  return { kind, isInvitation, isArchived, isUnread, ticket };
}

// ── Recency sort — shared by StreamInboxView + RecentConversationsStrip ────────────
// Newest `updated_date` first, with a STABLE `id` tiebreaker. Without the
// tiebreaker, rows with equal or missing `updated_date` fall back to the input
// order — which is the server's non-deterministic result order — so the list
// re-shuffled between fetches (i.e. on every stream inbox open). The tiebreaker makes
// the sort a total order, so equal-timestamp rows keep a fixed position.
export function compareConversationsByRecency(a: Conversation, b: Conversation): number {
  const ta = a.updated_date ? new Date(a.updated_date).getTime() : 0;
  const tb = b.updated_date ? new Date(b.updated_date).getTime() : 0;
  if (tb !== ta) return tb - ta;
  return (a.id ?? '').localeCompare(b.id ?? '');
}

// ── Chips — a per-row category label ─────────────────────────────────────────
// Chips can co-occur (a helpdesk row can also be archived), so this returns a
// list. Invitation rows keep their existing row treatment (violet left border +
// MailPlus + Accept), so they get no chip here.

export interface ChipSpec {
  key: string;
  icon: LucideIcon;
  label: string;
  /** Tone classes layered over the compact Badge in CategoryChips. */
  className: string;
}

const VIOLET_CHIP = 'border-violet-500/40 bg-violet-500/15 text-violet-600 dark:text-violet-400';
const MUTED_CHIP = 'border-border/60 bg-muted text-muted-foreground';

/** Whether `senderId` is the viewer. BOTH ids count: a locally written row is
 *  stamped with the desktop user id, a hub-mirrored row with the cloud user id,
 *  and the same person owns both — a message of mine that came back through the
 *  hub must not read as somebody else's. */
export function isViewer(senderId: string | null | undefined, viewer: CategoryInputs['viewer']): boolean {
  return !!senderId && (senderId === viewer.cloudUserId || senderId === viewer.localUserId);
}

const AMBER_CHIP = 'border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-300';
const EMERALD_CHIP = 'border-emerald-500/50 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300';

/** The state chip for a ticket facet — label depends on whose side the viewer is on. */
export function ticketChip(tk: TicketFacet): ChipSpec {
  const staff = tk.perspective === 'staff';
  if (tk.state === 'closed')
    return { key: 'ticket-closed', icon: CircleCheck, label: t`Closed`, className: MUTED_CHIP };
  if (tk.state === 'waiting') {
    return {
      key: 'ticket-waiting',
      icon: Clock,
      label: staff ? t`Not picked up` : t`Waiting for pickup`,
      className: AMBER_CHIP,
    };
  }
  const by = tk.pickedBy;
  const label = !staff || !by ? t`Picked up` : by === 'you' ? t`Picked up by you` : t`Picked up by ${by}`;
  return { key: 'ticket-picked', icon: UserCheck, label, className: EMERALD_CHIP };
}

export function chipsFor(f: ConversationFacets): ChipSpec[] {
  const chips: ChipSpec[] = [];
  if (f.kind === 'helpdesk') {
    chips.push({ key: 'helpdesk', icon: LifeBuoy, label: t`Support`, className: VIOLET_CHIP });
  }
  if (f.ticket) chips.push(ticketChip(f.ticket));
  if (f.isArchived) {
    chips.push({ key: 'archived', icon: Archive, label: t`Archived`, className: MUTED_CHIP });
  }
  return chips;
}

// ── Action strip — descriptor-driven, replaces inline role-branched JSX ───────

export type ActionTone = 'default' | 'destructive';

export interface ActionSpec {
  key: string;
  /** Tooltip + aria-label. */
  label: string;
  onClick: () => void;
  /** `icon` = small hover icon button; `primary` = filled text button (Accept). */
  kind: 'icon' | 'primary';
  icon?: LucideIcon;
  /** Button text for `kind === 'primary'`. */
  text?: string;
  tone?: ActionTone;
  disabled?: boolean;
  testId?: string;
}

/** Handlers + per-row state the row supplies; the spec builder picks which to
 *  surface based on the facets. */
export interface RowActionContext {
  invitationId?: string | null;
  accepting?: boolean;
  /** Resolved up-front so the delete tooltip distinguishes delete/leave/decline. */
  deleteLabel: string;
  onAccept: () => void;
  onDecline: () => void;
  onToggleRead: () => void;
  onArchive: () => void;
  onUnarchive: () => void;
  onDelete: () => void;
}

export function actionsFor(f: ConversationFacets, ctx: RowActionContext): ActionSpec[] {
  if (f.isInvitation) {
    const specs: ActionSpec[] = [
      {
        key: 'accept',
        kind: 'primary',
        text: ctx.accepting ? 'Accepting…' : 'Accept',
        label: t`Accept`,
        onClick: ctx.onAccept,
        disabled: ctx.accepting || !ctx.invitationId,
        testId: 'stream-inbox-accept-invitation-button',
      },
    ];
    if (ctx.invitationId) {
      specs.push({
        key: 'decline',
        kind: 'icon',
        icon: Trash2,
        tone: 'destructive',
        label: t`Decline (delete) invitation`,
        onClick: ctx.onDecline,
        testId: 'stream-inbox-invitation-delete-button',
      });
    }
    return specs;
  }

  return [
    {
      key: 'toggle-read',
      kind: 'icon',
      icon: CheckSquare,
      label: f.isUnread ? 'Mark read' : 'Mark unread',
      onClick: ctx.onToggleRead,
    },
    f.isArchived
      ? {
          key: 'unarchive',
          kind: 'icon',
          icon: ArchiveRestore,
          label: t`Unarchive — back to Stream Inbox`,
          onClick: ctx.onUnarchive,
          testId: 'stream-inbox-row-unarchive-button',
        }
      : {
          key: 'archive',
          kind: 'icon',
          icon: Archive,
          tone: 'destructive',
          label: t`Archive — moves to Archived, kept`,
          onClick: ctx.onArchive,
          testId: 'stream-inbox-row-archive-button',
        },
    {
      key: 'delete',
      kind: 'icon',
      icon: Trash2,
      tone: 'destructive',
      label: ctx.deleteLabel,
      onClick: ctx.onDelete,
      testId: 'stream-inbox-row-delete-button',
    },
  ];
}
