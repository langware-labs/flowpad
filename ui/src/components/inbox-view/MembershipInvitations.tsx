import { useCallback, useMemo, useState } from 'react';
import {
  Invitation,
  QueryRequest,
  acceptInvitation,
  declineInvitation,
  normalizeEmail,
} from '@sdk';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { Button } from '@src/components/ui/button';
import { Loader2 } from 'lucide-react';
import { notify } from '@src/notifications';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';

/**
 * Inbox rows for organization / team invitations.
 *
 * Unlike conversation invitations (which ride a ``remote=True`` Conversation
 * and render as a normal thread row), membership invitations have no backing
 * conversation — the SDK materializes them as ``Invitation`` entities carrying
 * a ``target_*`` descriptor. This renders them as generic "Organization/Team
 * invitation" rows with the same Accept / Decline controls, decoupled from any
 * conversation. Shown above the conversation list.
 */
export function MembershipInvitations({ recipientEmail }: { recipientEmail: string | null }) {
  const request = useMemo(() => new QueryRequest({ type: Invitation.type, query: {} }), []);
  const { data: invitations = [], refetch } = useEntitiesQuery<Invitation>(request);

  const pending = useMemo(() => {
    const email = normalizeEmail(recipientEmail);
    return invitations.filter((inv) => {
      const i = inv as any;
      if (!i.target_type || !i.target_id) return false; // conversation invites handled elsewhere
      if (i.accepted) return false;
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

function MembershipInvitationRow({
  invitation,
  onResolved,
}: {
  invitation: Invitation;
  onResolved: () => void;
}) {
  const inv = invitation as any;
  const [busy, setBusy] = useState<'accept' | 'decline' | null>(null);
  const targetType: string = inv.target_type;
  const Icon = iconForType(targetType);
  const kindLabel = targetType === 'team' ? 'Team invitation' : 'Organization invitation';
  const targetName: string = inv.target_name || (targetType === 'team' ? 'a team' : 'an organization');

  const accept = useCallback(async () => {
    if (!invitation.id) return;
    setBusy('accept');
    try {
      await acceptInvitation({ invitation_id: invitation.id });
      notify.success({ title: 'Joined', message: `You joined ${targetName}.`, id: 'membership-invite' });
      onResolved();
    } catch (err) {
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
    <div className="flex items-center gap-3 border-b border-border/40 border-l-2 border-l-violet-500 px-3 py-2">
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{kindLabel}</div>
        <div className="truncate text-xs text-muted-foreground">
          You’ve been invited to {targetName}
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
