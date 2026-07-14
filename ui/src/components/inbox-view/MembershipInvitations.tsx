import { useCallback, useMemo, useState } from 'react';
import {
  Invitation,
  QueryRequest,
  acceptInvitation,
  declineInvitation,
  isInvitationGoneError,
  normalizeEmail,
} from '@sdk';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { Button } from '@src/components/ui/button';
import { Loader2 } from 'lucide-react';
import { notify } from '@src/notifications';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { humanizeType } from '@src/tabs/provider-meta';

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

export function MembershipInvitations({ recipientEmail }: { recipientEmail: string | null }) {
  const request = useMemo(() => new QueryRequest({ type: Invitation.type, query: {} }), []);
  const { data: invitations = [], refetch } = useEntitiesQuery<Invitation>(request);

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

  if (pending.length === 0) return null;

  return (
    <div className="flex flex-col">
      {pending.map((inv) => (
        <MembershipInvitationRow key={inv.id} invitation={inv} onResolved={() => void refetch()} />
      ))}
    </div>
  );
}

function MembershipInvitationRow({ invitation, onResolved }: { invitation: Invitation; onResolved: () => void }) {
  const inv = invitation as any;
  const [busy, setBusy] = useState<'accept' | 'decline' | null>(null);
  const targetType: string = inv.target_type;
  const Icon = iconForType(targetType);
  // Any shareable entity type can be a target — label by its type
  // ("Organization invitation", "Skill invitation", …), never assume org.
  const kindLabel = `${humanizeType(targetType)} invitation`;
  const targetName: string = inv.target_name || `a ${humanizeType(targetType).toLowerCase()}`;
  const inviterName: string | null = (inv.inviter_name || '').trim() || null;

  const accept = useCallback(async () => {
    if (!invitation.id) return;
    setBusy('accept');
    try {
      await acceptInvitation({ invitation_id: invitation.id });
      notify.success({ title: 'Joined', message: `You joined ${targetName}.`, id: 'membership-invite' });
      onResolved();
    } catch (err) {
      if (isInvitationGoneError(err)) {
        // Orphan: the backend already removed the stale local row — just tell
        // the user and refetch so it drops (and stays gone across refresh).
        notify.warning({ title: 'Invitation no longer valid', id: 'membership-invite' });
        onResolved();
        return;
      }
      notify.error({
        title: 'Accept failed',
        message: err instanceof Error ? err.message : 'Unknown error.',
        id: 'membership-invite',
      });
    } finally {
      setBusy(null);
    }
  }, [invitation.id, targetName, onResolved]);

  const decline = useCallback(async () => {
    if (!invitation.id) return;
    setBusy('decline');
    try {
      await declineInvitation({ invitation_id: invitation.id });
      onResolved();
    } catch (err) {
      if (isInvitationGoneError(err)) {
        notify.warning({ title: 'Invitation no longer valid', id: 'membership-invite' });
        onResolved();
        return;
      }
      notify.error({
        title: 'Decline failed',
        message: err instanceof Error ? err.message : 'Unknown error.',
        id: 'membership-invite',
      });
    } finally {
      setBusy(null);
    }
  }, [invitation.id, onResolved]);

  return (
    <div className="flex items-center gap-3 border-b border-l-2 border-border/40 border-l-violet-500 px-3 py-2">
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{kindLabel}</div>
        <div className="truncate text-xs text-muted-foreground">
          {inviterName ? `${inviterName} invited you` : 'You’ve been invited'} to {targetName}
          {inv.target_role ? ` as ${inv.target_role}` : ''}.
        </div>
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
