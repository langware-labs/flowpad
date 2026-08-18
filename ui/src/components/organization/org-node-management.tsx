import { TypeId } from '@sdk';
import type { EntityMember } from '@sdk';
import { Loader2, Plus } from 'lucide-react';
import { useMemo } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

import { Button } from '@src/components/ui/button';
import { canInviteMembers } from '@src/components/conversation/participant-display';
import { useLocalUser } from '@src/components/conversation/useLocalUser';
import { useMembers } from '@src/hooks/use-members';
import { MemberSection, type MemberActions } from '@src/components/organization/member-list';
import { useCreateChildTeamForm } from '@src/components/organization/use-create-child-team';
import { notify } from '@src/notifications';

/**
 * Manage a school (organization) or a class (team) from the Organization
 * WorldView drawer.
 *
 * The graph is already the canonical org/team surface — it renders every team and
 * sub-team at any nesting depth — so management belongs on the node you selected
 * rather than on a competing page. This renders the same ``MemberSection`` the
 * account dialog uses, with ``manage`` on.
 *
 * A team that is a member of this entity comes back in the SAME roster payload as
 * a ``type: "team"`` row, so a class shows up inside its school here for free.
 */
export function OrgNodeManagement({
  nodeType,
  nodeId,
  nodeLabel,
  onStructureChanged,
}: {
  nodeType: string;
  nodeId: string;
  nodeLabel: string;
  /** Called after a team is created so the caller can reload the graph. */
  onStructureChanged?: () => void;
}) {
  const { t } = useLingui();
  const { localUser } = useLocalUser();
  const typeId = useMemo(() => new TypeId(nodeType, nodeId), [nodeType, nodeId]);
  const { members, ready, updating, stale, available, reason, refresh, removeMember, setRole } = useMembers(typeId);

  const me = members.find((m) => !!m.user_id && !!localUser?.id && m.user_id === localUser.id) ?? null;
  const mayManage = canInviteMembers(me as never);

  const actions: MemberActions = useMemo(
    () => ({
      onSetRole: async (principalId, role) => {
        try {
          await setRole(principalId, role);
        } catch (err) {
          // Surfaced, not swallowed: this is a deliberate page-like surface, and a
          // refused change (the hub's can_assign ceiling -> 403) is exactly what the
          // person needs to be told.
          notify.error({
            title: t`Could not change role`,
            message: err instanceof Error ? err.message : t`Unknown error.`,
            id: 'org-node-role',
          });
        }
      },
      onRemove: async (principalId) => {
        try {
          await removeMember(principalId);
        } catch (err) {
          notify.error({
            title: t`Could not remove member`,
            message: err instanceof Error ? err.message : t`Unknown error.`,
            id: 'org-node-remove',
          });
        }
      },
    }),
    [removeMember, setRole, t],
  );

  if (!available) {
    return (
      <div className="atlas-drawer-section" data-testid="org-management-unavailable">
        <h3>
          <Trans>Members</Trans>
        </h3>
        <div className="text-sm text-muted-foreground">
          {reason === 'local' ? (
            <Trans>Members are unavailable in Local mode.</Trans>
          ) : (
            <Trans>Sign in to manage members.</Trans>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="atlas-drawer-section" data-testid="org-management">
      <h3>
        <Trans>Members</Trans>
      </h3>
      <MemberSection
        members={members}
        ready={ready}
        updating={updating}
        stale={stale}
        selfId={localUser?.id ?? ''}
        me={me}
        manage={mayManage}
        actions={actions}
        footer={
          mayManage ? (
            <CreateTeamButton
              parentTypeId={typeId}
              parentLabel={nodeLabel}
              isOrganization={nodeType === 'organization'}
              onCreated={() => {
                void refresh();
                onStructureChanged?.();
              }}
            />
          ) : undefined
        }
      />
    </div>
  );
}

/**
 * Create a class (under a school) or a sub-team (under a class).
 *
 * Two calls, deliberately, because the hub expresses two different things:
 *   1. the scoped create writes the CONTAINMENT edge (parent -> team), which is
 *      what gives the parent's members their role on the new team;
 *   2. the members POST writes the MEMBERSHIP edge (team -> parent), which is what
 *      puts the team in the parent's roster.
 * Only the first is enough to see it; only the second makes it a member.
 */
function CreateTeamButton({
  parentTypeId,
  parentLabel,
  isOrganization,
  onCreated,
}: {
  parentTypeId: TypeId;
  parentLabel: string;
  isOrganization: boolean;
  onCreated: () => void;
}) {
  const { t } = useLingui();
  const { open, setOpen, name, setName, busy, submit } = useCreateChildTeamForm({
    parentTypeId,
    parentLabel,
    isOrganization,
    organizationCreatedTitle: t`Class created`,
    onCreated,
  });

  if (!open) {
    return (
      <button
        type="button"
        data-testid="org-create-team"
        className="mt-1 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        onClick={() => setOpen(true)}
      >
        <Plus size={12} />
        {isOrganization ? <Trans>New class</Trans> : <Trans>New sub-team</Trans>}
      </button>
    );
  }

  return (
    <div className="mt-1 flex items-center gap-2">
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit();
          if (e.key === 'Escape') setOpen(false);
        }}
        placeholder={isOrganization ? t`Class name…` : t`Sub-team name…`}
        data-testid="org-create-team-name"
        className="min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 py-1 text-sm"
      />
      <Button
        size="sm"
        disabled={busy || !name.trim()}
        onClick={() => void submit()}
        data-testid="org-create-team-submit"
      >
        {busy && <Loader2 className="h-4 w-4 animate-spin" />}
        <Trans>Create</Trans>
      </Button>
    </div>
  );
}
