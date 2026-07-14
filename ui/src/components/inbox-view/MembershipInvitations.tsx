import { useCallback, useMemo, useState } from 'react';
import { Invitation, QueryRequest, acceptInvitation, declineInvitation, normalizeEmail } from '@sdk';
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

/** Row title per target type — the row must say WHAT is being shared, not
 *  default everything to "Organization". */
const KIND_LABELS: Record<string, string> = {
  organization: 'Organization invitation',
  team: 'Team invitation',
  workspace: 'Workspace invitation',
  project: 'Project invitation',
  task: 'Task invitation',
};

/** "the task", "the project", … — reads naturally in the body sentence. */
const TARGET_NOUNS: Record<string, string> = {
  organization: 'the organization',
  team: 'the team',
  workspace: 'the workspace',
  project: 'the project',
  task: 'the task',
};

function MembershipInvitationRow({ invitation, onResolved }: { invitation: Invitation; onResolved: () => void }) {
  const inv = invitation as any;
  const [busy, setBusy] = useState<'accept' | 'decline' | null>(null);
  const targetType: string = inv.target_type;
  const Icon = iconForType(targetType);
  const kindLabel = KIND_LABELS[targetType] ?? 'Invitation';
  const targetName: string = inv.target_name || TARGET_NOUNS[targetType] || 'a shared item';
  const noun = TARGET_NOUNS[targetType];
  const targetLabel = inv.target_name && noun ? `${noun} “${inv.target_name}”` : targetName;
  const who = inv.sender_name ? `${inv.sender_name} invited you` : 'You’ve been invited';

  const accept = useCallback(async () => {
    if (!invitation.id) return;
    setBusy('accept');
    try {
      await acceptInvitation({ invitation_id: invitation.id });
      notify.success({
        title: 'Invitation accepted',
        message: `${targetLabel} is now available in your workspace.`,
        id: 'membership-invite',
      });
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
    <div className="flex items-center gap-3 border-b border-l-2 border-border/40 border-l-violet-500 px-3 py-2">
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
