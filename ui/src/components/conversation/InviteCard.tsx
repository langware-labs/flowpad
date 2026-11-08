import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useCallback, useMemo, useState } from 'react';
import { Check, Loader2, MailPlus } from 'lucide-react';
import {
  answerInvitation,
  invitationState,
  isInvitationGoneError,
  type IMessageInvite,
  type Invitation,
  type InvitationState,
} from '@sdk';
import { COMPACT } from '@src/components/conversation/CategoryChips';
import { iconForType, labelForType } from '@src/components/graph-view/icons/iconRegistry';
import { cn } from '@src/lib/utils';
import { buildDockPointer } from '@src/navigation/entity-pointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { notify } from '@src/notifications';
import { formatTimeAgo } from '@src/utils/format-time-ago';

/**
 * One share, as the person it was shared with sees it: what it is, who shared it, what became of it,
 * and the way in. Every share arrives as an invite message in the 1:1 conversation with the person who
 * shared (`FlowMessage.invite`, kept current by the hub); `layout="card"` is that message in the thread,
 * `layout="line"` the same share as one Stream Inbox line. Both read the same state and offer the same actions.
 */
export interface InviteView {
  invitationId: string;
  state: InvitationState;
  targetType: string;
  targetId: string;
  targetName?: string | null;
  roles?: string[];
  resolvedAt?: string | Date | null;
  senderName?: string | null;
  /** When it arrived — the line's time while nothing has been answered. */
  sentAt?: string | Date | null;
}

export function inviteFromMessage(
  invite: IMessageInvite,
  sender?: string | null,
  sentAt?: string | Date | null,
): InviteView {
  return {
    invitationId: invite.invitation_id,
    state: invite.state,
    targetType: invite.target_type,
    targetId: invite.target_id,
    targetName: invite.target_name,
    roles: invite.roles,
    resolvedAt: invite.resolved_at,
    senderName: sender,
    sentAt,
  };
}

/** A share the hub has not threaded yet (before its backfill): the Invitation row is all there is. */
export function inviteFromInvitation(inv: Invitation): InviteView | null {
  if (!inv.id || !inv.target_type || !inv.target_id) return null;
  return {
    invitationId: inv.id,
    state: invitationState(inv),
    targetType: inv.target_type,
    targetId: inv.target_id,
    targetName: inv.target_name,
    roles: inv.target_roles,
    resolvedAt: inv.resolved_at,
    senderName: inv.sender_name,
    sentAt: inv.created_date,
  };
}

const STATE_TONE: Record<InvitationState, string> = {
  pending: 'border-violet-500/50 bg-violet-500/15 text-violet-700 dark:text-violet-300',
  accepted: 'border-emerald-500/50 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  declined: 'border-dashed border-border text-muted-foreground',
  revoked: 'border-dashed border-border text-muted-foreground',
};

function stateLabel(state: InvitationState, mine?: boolean): string {
  if (state === 'accepted') return t`Accepted`;
  if (state === 'declined') return t`Declined`;
  if (state === 'revoked') return t`No longer shared`;
  return mine ? t`Waiting for an answer` : t`Waiting for you`;
}

/** The state of a share as a small chip — on the card, the Stream Inbox line and a conversation row. */
export function InviteStateChip({
  state,
  resolvedAt,
  busy,
  mine,
  className,
}: {
  state: InvitationState;
  resolvedAt?: string | Date | null;
  busy?: boolean;
  /** The sharer's own copy of the invite. */
  mine?: boolean;
  className?: string;
}) {
  const when = state === 'pending' ? null : formatTimeAgo(resolvedAt as string | undefined);
  return (
    <span
      data-testid="invite-state"
      data-state={busy ? 'accepting' : state}
      className={cn(
        'inline-flex items-center',
        COMPACT,
        busy ? 'border-sky-500/50 bg-sky-500/15 text-sky-700 dark:text-sky-300' : STATE_TONE[state],
        className,
      )}
    >
      {!busy && state === 'accepted' && <Check className="h-2.5 w-2.5" />}
      {busy ? t`Accepting…` : when ? `${stateLabel(state, mine)} · ${when}` : stateLabel(state, mine)}
    </span>
  );
}

/** Accept / Decline, answered where this page runs (`answerInvitation`). */
function useInviteAnswer(invitationId: string) {
  const [busy, setBusy] = useState<'accept' | 'decline' | null>(null);
  // What this click decided, shown until the hub's update of the message arrives.
  const [answered, setAnswered] = useState<InvitationState | null>(null);
  const answer = useCallback(
    async (choice: 'accept' | 'decline') => {
      setBusy(choice);
      try {
        await answerInvitation(invitationId, choice);
        setAnswered(choice === 'accept' ? 'accepted' : 'declined');
      } catch (err) {
        if (isInvitationGoneError(err)) {
          setAnswered('revoked');
          return;
        }
        notify.error({
          title: choice === 'accept' ? t`Accept failed` : t`Decline failed`,
          message: err instanceof Error ? err.message : t`Unknown error.`,
          id: 'invite-answer',
        });
      } finally {
        setBusy(null);
      }
    },
    [invitationId],
  );
  return { busy, answered, answer };
}

const PRIMARY =
  'rounded bg-primary px-2 py-0.5 text-[11px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50';
const OUTLINE =
  'rounded border border-border px-2 py-0.5 text-[11px] font-medium text-foreground hover:bg-muted disabled:opacity-50';

export function InviteCard({
  invite,
  layout,
  mine = false,
}: {
  invite: InviteView;
  layout: 'card' | 'line';
  /** The sharer's own copy: it reads the answer; Accept / Decline are the other person's. */
  mine?: boolean;
}) {
  const { navigation } = useDockNavigation();
  const { busy, answered, answer } = useInviteAnswer(invite.invitationId);
  // The hub's state wins once it moves past what this click decided.
  const hubAnswered = invite.state !== 'pending';
  const state: InvitationState = hubAnswered ? invite.state : (answered ?? 'pending');
  const resolvedAt = hubAnswered ? invite.resolvedAt : answered ? new Date() : null;

  const Icon = iconForType(invite.targetType);
  const typeLabel = labelForType(invite.targetType);
  const typeNoun = typeLabel.toLowerCase();
  const name = invite.targetName || t`the ${typeNoun}`;
  const sender = invite.senderName || t`Someone`;
  const target = useMemo(
    () => buildDockPointer({ type: invite.targetType, id: invite.targetId }, undefined),
    [invite.targetType, invite.targetId],
  );
  const pending = state === 'pending';
  const dim = state === 'declined' || state === 'revoked';

  const actions = pending && mine ? null : pending ? (
    <>
      <button
        type="button"
        className={OUTLINE}
        disabled={busy !== null}
        onClick={() => void answer('decline')}
        data-testid="invite-decline"
      >
        {busy === 'decline' && <Loader2 className="me-1 inline h-3 w-3 animate-spin" />}
        <Trans>Decline</Trans>
      </button>
      <button
        type="button"
        className={PRIMARY}
        disabled={busy !== null}
        onClick={() => void answer('accept')}
        data-testid="invite-accept"
      >
        {busy === 'accept' ? t`Accepting…` : t`Accept`}
      </button>
    </>
  ) : state === 'declined' ? null : (
    <button
      type="button"
      className={state === 'accepted' ? PRIMARY : OUTLINE}
      disabled={state !== 'accepted' || !target}
      title={
        state === 'revoked'
          ? t`${sender} stopped sharing this ${typeNoun}`
          : !target
            ? t`This ${typeNoun} has no page to open here`
            : undefined
      }
      onClick={(e) => {
        e.stopPropagation();
        if (target) navigation.openDock(target);
      }}
      data-testid="invite-open"
    >
      <Trans>Open</Trans>
    </button>
  );

  const chip = <InviteStateChip state={state} resolvedAt={resolvedAt} busy={busy === 'accept'} mine={mine} />;

  if (layout === 'card') {
    return (
      <div
        data-testid="invite-card"
        data-invite-state={state}
        className={cn(
          'mt-2 flex max-w-2xl items-center gap-3 rounded-md border border-border bg-muted/20 px-3 py-2 text-sm',
          dim && 'opacity-60',
        )}
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
          <Icon className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-foreground">{name}</span>
          <span className="block truncate text-xs text-muted-foreground">
            <Trans>
              {typeLabel} · shared by {sender}
            </Trans>
          </span>
        </span>
        {chip}
        <span className="flex shrink-0 items-center gap-1">{actions}</span>
      </div>
    );
  }

  const time = formatTimeAgo((invite.resolvedAt ?? invite.sentAt) as string | undefined);
  return (
    <div
      data-testid="invite-line"
      data-invite-state={state}
      className={cn(
        'flex h-9 items-center gap-3 border-b border-s-2 border-border/40 border-s-violet-500/60 px-3 text-sm',
        pending ? 'bg-background' : 'bg-muted/20',
        dim && 'opacity-60',
      )}
    >
      <span
        className={cn(
          'flex w-[var(--stream-inbox-from-width)] shrink-0 items-center gap-1',
          pending ? 'font-semibold text-foreground' : 'text-muted-foreground',
        )}
      >
        <MailPlus className="h-3.5 w-3.5 flex-shrink-0 text-violet-500" aria-label="invitation" />
        <span className="min-w-0 flex-1 truncate">{sender}</span>
      </span>
      <span className="min-w-0 flex-1 truncate">
        <span className={cn('me-1 inline-flex items-center border-border text-muted-foreground', COMPACT)}>
          <Icon className="h-2.5 w-2.5" />
          {typeLabel}
        </span>
        {chip}
        <span className={cn('ms-1', pending ? 'font-semibold text-foreground' : 'text-foreground/80')}>
          <Trans>
            shared {typeNoun} <b>{name}</b> with you
          </Trans>
        </span>
      </span>
      {time && <span className="shrink-0 text-xs text-muted-foreground">{time}</span>}
      <span className="flex shrink-0 items-center gap-1">{actions}</span>
    </div>
  );
}
