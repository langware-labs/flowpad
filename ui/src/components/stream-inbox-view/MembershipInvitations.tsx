import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Invitation,
  QueryRequest,
  fetchPendingInvitations,
  hubModeReady,
  invitationState,
  isHubOnly,
  normalizeEmail,
} from '@sdk';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { InviteCard, inviteFromInvitation } from '@src/components/conversation/InviteCard';
import { cn } from '@src/lib/utils';

/**
 * Shares the hub has not put in a conversation yet. Every share now arrives as an invite message in the
 * 1:1 conversation with the person who shared (`InviteCard` in the thread); an invitation from before
 * that — until the hub's backfill threads it — has only its Invitation row, so it is listed here, with
 * the same card, as one line. A threaded invitation (its `target_url_path` names a conversation) is the
 * conversation's to show, never listed twice.
 */
function isExpired(inv: Invitation): boolean {
  const raw = inv.expiration_at;
  if (!raw) return false;
  const at = raw instanceof Date ? raw : new Date(raw);
  return !Number.isNaN(at.getTime()) && at.getTime() < Date.now();
}

const isThreaded = (inv: Invitation) => (inv.target_url_path ?? '').startsWith('/conversation/');

export function MembershipInvitations({
  recipientEmail,
  onPendingCount,
  show,
}: {
  recipientEmail: string | null;
  /** `pending`: what still waits for an answer (All / Unread). `all`: the Invites view, whatever became of it. */
  show: 'pending' | 'all';
  /** The rendered pending count, for the parent's empty state — the unread badge is the backend's. */
  onPendingCount?: (count: number) => void;
}) {
  // `isHubOnly()` is only trustworthy after `hubModeReady()`; `null` = not known yet, nothing runs.
  const [hubMode, setHubMode] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    void hubModeReady().then(() => alive && setHubMode(isHubOnly()));
    return () => {
      alive = false;
    };
  }, []);

  const request = useMemo(() => new QueryRequest({ type: Invitation.type, query: {} }), []);
  const { data: mirrored = [] } = useEntitiesQuery<Invitation>(request, { enabled: hubMode === false });

  // The hub page has no local mirror: an invitation has no owner, so a role-scoped read returns nothing
  // to the person it is addressed to. The hub's `pending` self-scopes on the recipient's email.
  const [fetched, setFetched] = useState<Invitation[]>([]);
  const loadFromHub = useCallback(async () => {
    try {
      setFetched(await fetchPendingInvitations());
    } catch {
      // A failed poll keeps the previous rows rather than blanking the Stream Inbox.
    }
  }, []);
  useEffect(() => {
    if (hubMode) void loadFromHub();
  }, [hubMode, loadFromHub]);

  const invitations = hubMode ? fetched : mirrored;
  const lines = useMemo(() => {
    const email = normalizeEmail(recipientEmail);
    return invitations
      .filter((inv) => {
        if (isThreaded(inv)) return false;
        if (email && normalizeEmail(inv.recipient_email) !== email) return false;
        // An unanswered invitation that expired is dead — accepting it would 410 on the hub.
        if (invitationState(inv) === 'pending') return !isExpired(inv);
        return show === 'all';
      })
      .flatMap((inv) => inviteFromInvitation(inv) ?? [])
      .sort((a, b) => lineTime(b) - lineTime(a));
  }, [invitations, recipientEmail, show]);
  const pendingCount = lines.filter((v) => v.state === 'pending').length;

  useEffect(() => {
    onPendingCount?.(pendingCount);
  }, [pendingCount, onPendingCount]);

  if (lines.length === 0) return null;
  return (
    <div className="flex flex-col">
      {lines.map((v) => (
        <InviteCard key={v.invitationId} invite={v} layout="line" />
      ))}
    </div>
  );
}

function lineTime(v: { resolvedAt?: string | Date | null; sentAt?: string | Date | null }): number {
  const raw = v.resolvedAt ?? v.sentAt;
  const at = raw ? new Date(raw).getTime() : 0;
  return Number.isNaN(at) ? 0 : at;
}

/** "Shared with me": the share mark with an arrow coming in toward the reader. */
function SharedWithMeIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <g transform="translate(7.5 0) scale(0.68)" strokeWidth={2.9}>
        <circle cx="18" cy="5" r="3" />
        <circle cx="6" cy="12" r="3" />
        <circle cx="18" cy="19" r="3" />
        <path d="M8.59 13.51l6.83 3.98M15.41 6.51l-6.82 3.98" />
      </g>
      <path d="M9.5 14.5L2.5 21.5M2.5 15.5v6h6" />
    </svg>
  );
}

/** The Invites chip: first in the Stream Inbox's channel row. Its active state is the URL's (`?view=invites`). */
export function InvitesChannelChip({
  active,
  pending,
  onClick,
}: {
  active: boolean;
  pending: number;
  onClick: () => void;
}) {
  // Same round mark as the channels beside it; lit while the Invites view is open.
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={t`Invites — everything shared with you`}
      title={t`Invites — everything shared with you`}
      data-testid="stream-inbox-invites-chip"
      className={cn(
        'relative grid size-8 shrink-0 place-items-center rounded-full border-[1.5px] bg-background transition-colors hover:border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active ? 'border-violet-500' : 'border-border [&>:first-child]:opacity-45 [&>:first-child]:grayscale',
      )}
    >
      <SharedWithMeIcon className="size-[18px] text-violet-500" />
      {pending > 0 && (
        <span className="absolute -bottom-0.5 -end-0.5 grid min-w-3.5 place-items-center rounded-full border-2 border-background bg-violet-500 px-0.5 text-[9px] leading-none text-white">
          {pending}
        </span>
      )}
    </button>
  );
}
