import { TypeId } from '@sdk';
import type { EntityMember } from '@sdk';
import { Building2, Loader2, Plus, UserPlus, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Plural, Trans, useLingui } from '@lingui/react/macro';

import { Button } from '@src/components/ui/button';
import { canInviteMembers } from '@src/components/conversation/participant-display';
import { useLocalUser } from '@src/components/conversation/useLocalUser';
import { useMembers } from '@src/hooks/use-members';
import {
  MemberRow,
  isGroupMember,
  memberPrincipalId,
  type MemberActions,
} from '@src/components/organization/member-list';
import { InviteRow } from '@src/components/organization/invite-row';
import { useCreateChildTeamForm } from '@src/components/organization/use-create-child-team';
import { notify } from '@src/notifications';

/**
 * The detail half of the People & teams screen: who belongs to the selected
 * organization or team, and the controls to change that.
 *
 * People and teams are shown as two labelled groups rather than one mixed list.
 * They are genuinely different things — a team confers its role on everyone
 * inside it — and the hub already distinguishes them in the payload. Mixing them
 * is what made the earlier version hard to read.
 */
export function OrgDetailPanel({
  nodeType,
  nodeId,
  nodeLabel,
  onOpenChild,
}: {
  nodeType: string;
  nodeId: string;
  nodeLabel: string;
  onOpenChild?: (node: { type: string; id: string; label: string }) => void;
}) {
  const { t } = useLingui();
  const { localUser } = useLocalUser();
  const typeId = useMemo(() => new TypeId(nodeType, nodeId), [nodeType, nodeId]);
  const { members, ready, updating, stale, refresh, removeMember, setRole } = useMembers(typeId);
  const [inviteOpen, setInviteOpen] = useState(false);

  const me = members.find((m) => !!m.user_id && !!localUser?.id && m.user_id === localUser.id) ?? null;
  const mayManage = canInviteMembers(me as never);
  const isOrg = nodeType === 'organization';

  const people = useMemo(() => members.filter((m) => !isGroupMember(m as never)), [members]);
  const teams = useMemo(() => members.filter((m) => isGroupMember(m as never)), [members]);

  const actions: MemberActions = useMemo(
    () => ({
      onSetRole: async (principalId, role) => {
        try {
          await setRole(principalId, role);
        } catch (err) {
          notify.error({
            title: t`Could not change role`,
            message: err instanceof Error ? err.message : t`Unknown error.`,
            id: 'org-role',
          });
        }
      },
      onRemove: async (principalId) => {
        try {
          await removeMember(principalId);
        } catch (err) {
          notify.error({
            title: t`Could not remove`,
            message: err instanceof Error ? err.message : t`Unknown error.`,
            id: 'org-remove',
          });
        }
      },
    }),
    [removeMember, setRole, t],
  );

  return (
    <section className="flex flex-col gap-5" data-testid="org-detail">
      <header className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          {isOrg ? <Building2 className="h-5 w-5" /> : <Users className="h-5 w-5" />}
          <div>
            <h2 className="text-base font-semibold">{nodeLabel}</h2>
            <p className="text-xs text-muted-foreground">
              <Plural value={people.length} one="# person" other="# people" />
              {' · '}
              <Plural value={teams.length} one="# team" other="# teams" />
              {me?.role ? <Trans> · you are {me.role}</Trans> : null}
            </p>
          </div>
          {updating && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        </div>
        {mayManage && !stale && (
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" data-testid="org-invite-open" onClick={() => setInviteOpen((v) => !v)}>
              <UserPlus className="h-4 w-4" />
              <Trans>Invite people</Trans>
            </Button>
            <CreateChildButton
              parentTypeId={typeId}
              parentLabel={nodeLabel}
              isOrganization={isOrg}
              onCreated={() => void refresh()}
            />
          </div>
        )}
      </header>

      {inviteOpen && mayManage && (
        <InviteRow
          entityTypeId={typeId}
          me={me}
          onInvited={() => {
            setInviteOpen(false);
            void refresh();
          }}
        />
      )}

      {stale && (
        <div className="rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">
          <Trans>Can't update right now — showing the last synced list.</Trans>
        </div>
      )}

      <Group
        title={t`People`}
        empty={t`No people yet.`}
        rows={people}
        ready={ready}
        me={me}
        manage={mayManage}
        actions={actions}
        selfId={localUser?.id ?? ''}
      />

      <Group
        title={isOrg ? t`Teams in this organization` : t`Teams inside this team`}
        empty={isOrg ? t`No teams yet.` : t`No sub-teams yet.`}
        rows={teams}
        ready={ready}
        me={me}
        manage={mayManage}
        actions={actions}
        selfId={localUser?.id ?? ''}
        onOpenRow={(row) =>
          onOpenChild?.({
            type: 'team',
            id: memberPrincipalId(row) || '',
            label: (row as unknown as { name?: string }).name || 'Team',
          })
        }
      />
    </section>
  );
}

function Group({
  title,
  empty,
  rows,
  ready,
  me,
  manage,
  actions,
  selfId,
  onOpenRow,
}: {
  title: string;
  empty: string;
  rows: EntityMember[];
  ready: boolean;
  me: EntityMember | null;
  manage: boolean;
  actions: MemberActions;
  selfId: string;
  onOpenRow?: (row: EntityMember) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</div>
      {!ready && rows.length === 0 ? (
        <div className="text-sm text-muted-foreground">
          <Trans>Loading…</Trans>
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
          {empty}
        </div>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
          {rows.map((row, i) => (
            <div key={memberPrincipalId(row) ?? i} className="px-3 py-2" onDoubleClick={() => onOpenRow?.(row)}>
              <MemberRow member={row} isSelf={row.user_id === selfId} me={me} manage={manage} actions={actions} />
            </div>
          ))}
        </ul>
      )}
    </div>
  );
}

function CreateChildButton({
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
    organizationCreatedTitle: t`Team created`,
    onCreated,
  });

  if (!open) {
    return (
      <Button size="sm" data-testid="org-create-team" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" />
        {isOrganization ? <Trans>New team</Trans> : <Trans>New sub-team</Trans>}
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit();
          if (e.key === 'Escape') setOpen(false);
        }}
        placeholder={isOrganization ? t`Team name…` : t`Sub-team name…`}
        data-testid="org-create-team-name"
        className="w-40 rounded-md border border-border bg-background px-2.5 py-1 text-sm"
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
