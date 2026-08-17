import { t } from '@lingui/core/macro';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Invitation,
  QueryRequest,
  acceptInvitation,
  acceptInvitationOnHub,
  declineInvitation,
  declineInvitationOnHub,
  fetchPendingInvitations,
  hubModeReady,
  isHubOnly,
  isInvitationGoneError,
  normalizeEmail,
} from '@sdk';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { Button } from '@src/components/ui/button';
import { Loader2 } from 'lucide-react';
import { notify } from '@src/notifications';
import { iconForType, labelForType } from '@src/components/graph-view/icons/iconRegistry';

/**
 * Inbox rows for entity-share invitations (organization, team, workspace,
 * project, skill, … — any shareable entity type).
 *
 * Unlike conversation invitations (which ride a ``remote=True`` Conversation
 * and render as a normal thread row), these have no backing conversation —
 * the SDK materializes them as ``Invitation`` entities carrying a
 * ``target_*`` descriptor. This renders them as
 * "<inviter> invited you to <target>" rows with Accept / Decline controls,
 * decoupled from any conversation. Shown above the conversation list.
 */
function isExpired(inv: Invitation): boolean {
  const raw = (inv as any).expiration_at;
  if (!raw) return false;
  const at = raw instanceof Date ? raw : new Date(raw);
  return !Number.isNaN(at.getTime()) && at.getTime() < Date.now();
}

export function MembershipInvitations({
  recipientEmail,
  onPendingCount,
}: {
  recipientEmail: string | null;
  /** Reports the rendered pending count so the parent's empty-state logic can
   *  account for these rows (a membership-only inbox must not also say
   *  "No unread conversations"). Rendering only — the numeric unread badge is
   *  backend-owned (InboxManager.unread) and never derived from this list. */
  onPendingCount?: (count: number) => void;
}) {
  // `isHubOnly()` reads its `[desk]` default until bootstrap resolves, so it is
  // only trustworthy after `hubModeReady()` — checking it during the first
  // render would classify a hub as a desktop and silently pick the wrong
  // source. `null` means "not known yet", and neither source runs until it is.
  const [hubMode, setHubMode] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    void hubModeReady().then(() => {
      if (alive) setHubMode(isHubOnly());
    });
    return () => {
      alive = false;
    };
  }, []);

  const request = useMemo(() => new QueryRequest({ type: Invitation.type, query: {} }), []);
  const { data: mirrored = [], refetch: refetchMirrored } = useEntitiesQuery<Invitation>(request, {
    enabled: hubMode === false,
  });

  // Hub mode has no local mirror of these rows, and the generic query above
  // cannot substitute for one: invitations are saved with NO owner, so a
  // recipient holds no role on the row and the role-scoped read returns nothing
  // for exactly the people it is addressed to. The hub's `pending` action
  // self-scopes on the recipient's email instead.
  const [fetched, setFetched] = useState<Invitation[]>([]);
  const loadFromHub = useCallback(async () => {
    try {
      setFetched(await fetchPendingInvitations());
    } catch {
      // A failed poll keeps the previous rows rather than blanking the inbox.
    }
  }, []);
  useEffect(() => {
    if (hubMode) void loadFromHub();
  }, [hubMode, loadFromHub]);

  const invitations = hubMode ? fetched : mirrored;
  const refetch = useCallback(() => {
    void (hubMode ? loadFromHub() : refetchMirrored());
  }, [hubMode, loadFromHub, refetchMirrored]);

  const pending = useMemo(() => {
    const email = normalizeEmail(recipientEmail);
    return invitations.filter((inv) => {
      const i = inv as any;
      if (!i.target_type || !i.target_id) return false; // conversation invites handled elsewhere
      if (i.accepted) return false;
      // An expired invitation is dead — accepting it would 410 on the hub.
      // The sync prunes expired rows; this covers ones awaiting the prune.
      if (isExpired(inv)) return false;
      // Only show invitations addressed to the current user (when we know them).
      if (email && normalizeEmail(i.recipient_email) !== email) return false;
      return true;
    });
  }, [invitations, recipientEmail]);

  useEffect(() => {
    onPendingCount?.(pending.length);
  }, [pending.length, onPendingCount]);

  if (pending.length === 0) return null;

  return (
    <div className="flex flex-col">
      {pending.map((inv) => (
        <MembershipInvitationRow key={inv.id} invitation={inv} hubMode={!!hubMode} onResolved={() => void refetch()} />
      ))}
    </div>
  );
}

function MembershipInvitationRow({
  invitation,
  onResolved,
  hubMode,
}: {
  invitation: Invitation;
  onResolved: () => void;
  /** Hub and desktop expose DIFFERENT accept/decline endpoints — see
   *  `acceptInvitationOnHub`. Passed down rather than re-derived so the row
   *  cannot disagree with the list about which backend it is on. */
  hubMode: boolean;
}) {
  const inv = invitation as any;
  const [busy, setBusy] = useState<'accept' | 'decline' | null>(null);
  const targetType: string = inv.target_type;
  const Icon = iconForType(targetType);
  // Label + noun come from the backend type registry (never a hardcoded per-type
  // map), so coverage tracks the icon and can't drift as new target types ship.
  const typeLabel = labelForType(targetType);
  const kindLabel = `${typeLabel} invitation`;
  const noun = `the ${typeLabel.toLowerCase()}`;
  const targetLabel = inv.target_name ? `${noun} “${inv.target_name}”` : noun;
  const who = inv.sender_name ? `${inv.sender_name} invited you` : 'You’ve been invited';

  const accept = useCallback(async () => {
    if (!invitation.id) return;
    setBusy('accept');
    try {
      if (hubMode) await acceptInvitationOnHub(invitation.id);
      else await acceptInvitation({ invitation_id: invitation.id });
      notify.success({
        title: t`Invitation accepted`,
        message: t`${targetLabel} is now available in your workspace.`,
        id: 'membership-invite',
      });
      onResolved();
    } catch (err) {
      if (isInvitationGoneError(err)) {
        // Orphan: the backend already removed the stale local row — just tell
        // the user and refetch so it drops (and stays gone across refresh).
        notify.warning({ title: t`Invitation no longer valid`, id: 'membership-invite' });
        onResolved();
        return;
      }
      notify.error({
        title: t`Accept failed`,
        message: err instanceof Error ? err.message : 'Unknown error.',
        id: 'membership-invite',
      });
    } finally {
      setBusy(null);
    }
  }, [invitation.id, targetLabel, onResolved, hubMode]);

  const decline = useCallback(async () => {
    if (!invitation.id) return;
    setBusy('decline');
    try {
      if (hubMode) await declineInvitationOnHub(invitation.id);
      else await declineInvitation({ invitation_id: invitation.id });
      onResolved();
    } catch (err) {
      if (isInvitationGoneError(err)) {
        notify.warning({ title: t`Invitation no longer valid`, id: 'membership-invite' });
        onResolved();
        return;
      }
      notify.error({
        title: t`Decline failed`,
        message: err instanceof Error ? err.message : 'Unknown error.',
        id: 'membership-invite',
      });
    } finally {
      setBusy(null);
    }
  }, [invitation.id, onResolved, hubMode]);

  return (
    <div className="flex items-center gap-3 border-b border-s-2 border-border/40 border-s-violet-500 px-3 py-2">
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{kindLabel}</div>
        <div className="truncate text-xs text-muted-foreground">
          {who} to {targetLabel}
          {inv.target_role ? ` as ${inv.target_role}` : ''}.
        </div>
        {inv.message && <div className="truncate text-xs text-muted-foreground/80">{inv.message}</div>}
      </div>
      <Button size="sm" disabled={busy !== null} onClick={() => void accept()}>
        {busy === 'accept' && <Loader2 className="h-4 w-4 animate-spin" />}
        Accept
      </Button>
      <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void decline()}>
        {busy === 'decline' && <Loader2 className="h-4 w-4 animate-spin" />}
        Decline
      </Button>
    </div>
  );
}
