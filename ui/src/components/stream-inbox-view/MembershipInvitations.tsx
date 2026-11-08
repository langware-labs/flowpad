import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { MailPlus } from 'lucide-react';
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
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={t`Everything shared with you`}
      data-testid="stream-inbox-invites-chip"
      className={cn(
        'flex h-7 shrink-0 items-center gap-1 rounded-md border px-2 text-xs font-medium transition-colors',
        active
          ? 'border-violet-500/60 bg-violet-500/15 text-foreground'
          : 'border-border/60 text-muted-foreground hover:text-foreground',
      )}
    >
      <MailPlus className="h-3.5 w-3.5 text-violet-500" />
      <Trans>Invites</Trans>
      {pending > 0 && (
        <span className="rounded bg-violet-500 px-1 text-[10px] leading-tight text-white">{pending}</span>
      )}
    </button>
  );
}
