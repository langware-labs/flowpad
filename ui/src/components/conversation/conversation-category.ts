import type { LucideIcon } from 'lucide-react';
import { Archive, ArchiveRestore, CheckSquare, LifeBuoy, Trash2 } from 'lucide-react';
import {
  Conversation,
  ConversationKind,
  FlowMessage,
  FlowMessageKind,
  Invitation,
} from '@sdk';

// ── Conversation category — the single source of truth ──────────────────────
// The inbox "category" is NOT one axis: a conversation can be community AND
// archived AND unread at once, and two of the axes (unread, invitation) are
// *viewer-relative* — the same thread is an "Accept" row for the recipient and
// a normal row for the sender. So we derive a small facet struct (centralizing
// what InboxView and RecentConversationsStrip each used to derive separately)
// plus a priority-collapsed `primary` for the cases that need one value.
//
// This is derived view-model logic, NOT persisted state — `kind` and
// `archived_at` are the only stored fields; everything else is computed here.

export interface CategoryInputs {
  conv: Conversation;
  /** First message — used only to detect `kind === 'invitation'`. */
  firstMessage?: FlowMessage | null;
  /** Latest message — drives the unread facet. */
  latestMessage?: FlowMessage | null;
  /** Latest pointer ts (from `conversationMessageIds`). Used for the archived
   *  comparison so we don't race the async FlowMessage fetch — the pointer
   *  lands with the conversation entity, the FM entity arrives later. */
  latestPtrTs?: string | null;
  /** Invitation entity off the first message's context (if any). */
  invitation?: Invitation | null;
  /** The local viewer — invitation/ownership are relative to this. */
  viewer: { email: string; cloudUserId: string | null };
}

export interface ConversationFacets {
  kind: 'direct' | 'community';
  /** Viewer is the pending recipient of an unaccepted invitation. */
  isInvitation: boolean;
  /** `archived_at` is set and not yet revived by newer activity. */
  isArchived: boolean;
  /** Latest received message is unread (invitation rows count as unread). */
  isUnread: boolean;
}

/** Derive the category facets for a conversation row. Pure — no hooks, safe to
 *  call anywhere in a component (it is not a React hook). */
export function conversationFacets(inp: CategoryInputs): ConversationFacets {
  const { conv, firstMessage, latestMessage, latestPtrTs, invitation, viewer } = inp;

  const kind = conv.kind === ConversationKind.COMMUNITY ? 'community' : 'direct';

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
  const isArchived =
    archivedAt !== null && !Number.isNaN(archivedAt) && latestTime <= archivedAt;

  // Unread — invitation rows always carry an actionable CTA, so count as unread.
  const isUnread = isInvitation
    ? true
    : latestMessage
      ? !latestMessage.is_read
      : false;

  return { kind, isInvitation, isArchived, isUnread };
}

// ── Chips — a per-row category label ─────────────────────────────────────────
// Chips can co-occur (a community row can also be archived), so this returns a
// list. Invitation rows keep their existing row treatment (violet left border +
// MailPlus + Accept), so they get no chip here.

export interface ChipSpec {
  key: string;
  icon: LucideIcon;
  label: string;
  /** Tone classes layered over the compact Badge in CategoryChips. */
  className: string;
}

const VIOLET_CHIP =
  'border-violet-500/40 bg-violet-500/15 text-violet-600 dark:text-violet-400';
const MUTED_CHIP = 'border-border/60 bg-muted text-muted-foreground';

export function chipsFor(f: ConversationFacets): ChipSpec[] {
  const chips: ChipSpec[] = [];
  if (f.kind === 'community') {
    chips.push({ key: 'community', icon: LifeBuoy, label: 'Support', className: VIOLET_CHIP });
  }
  if (f.isArchived) {
    chips.push({ key: 'archived', icon: Archive, label: 'Archived', className: MUTED_CHIP });
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
        label: 'Accept',
        onClick: ctx.onAccept,
        disabled: ctx.accepting || !ctx.invitationId,
        testId: 'inbox-accept-invitation-button',
      },
    ];
    if (ctx.invitationId) {
      specs.push({
        key: 'decline',
        kind: 'icon',
        icon: Trash2,
        tone: 'destructive',
        label: 'Decline (delete) invitation',
        onClick: ctx.onDecline,
        testId: 'inbox-invitation-delete-button',
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
          label: 'Unarchive — back to Inbox',
          onClick: ctx.onUnarchive,
          testId: 'inbox-row-unarchive-button',
        }
      : {
          key: 'archive',
          kind: 'icon',
          icon: Archive,
          tone: 'destructive',
          label: 'Archive — moves to Archived, kept',
          onClick: ctx.onArchive,
          testId: 'inbox-row-archive-button',
        },
    {
      key: 'delete',
      kind: 'icon',
      icon: Trash2,
      tone: 'destructive',
      label: ctx.deleteLabel,
      onClick: ctx.onDelete,
      testId: 'inbox-row-delete-button',
    },
  ];
}
