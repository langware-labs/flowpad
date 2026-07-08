import { APIEntity, normalizeEmail, QueryRequest, TypeId, User } from '@sdk';
import { useCallback, useMemo, useState } from 'react';
import { Button } from '@src/components/ui/button';
import { Loader2 } from 'lucide-react';
import { useEntity } from '@src/hooks/entity-hooks/useEntity';
import { useEntitiesQuery } from '@src/hooks/entity-hooks/useEntitiesQuery';
import { useMembers } from '@src/hooks/use-members';
import {
  avatarColorForParticipant,
} from '@src/components/conversation/avatar-color';
import {
  canInviteMembers,
  participantInitials,
  participantLabel,
  participantRoleLabel,
} from '@src/components/conversation/participant-display';
import type { EntityMember } from '@sdk';
import { notify } from '@src/notifications';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { Trans, useLingui } from '@lingui/react/macro';

interface OrganizationPanelProps {
  user: User;
}

/**
 * Organization settings tab. Replaces the old Account tab's sole purpose with a
 * view of the user's organization: its member roster (reusing the same
 * ``useMembers`` + participant-display helpers the conversation roster uses), a
 * permission-gated invite box, and a sub-section listing the teams the client
 * knows the user belongs to.
 */
export function OrganizationPanel({ user }: OrganizationPanelProps) {
  const orgId = user.organization_id;
  if (!orgId) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        <Trans>You don’t belong to an organization yet. Organizations are set up in Flowpad Cloud; once you’re added, your organization and its members appear here.</Trans>
      </div>
    );
  }
  return <OrganizationBody user={user} orgId={orgId} />;
}

function OrganizationBody({ user, orgId }: { user: User; orgId: string }) {
  const { t } = useLingui();
  const orgTypeId = useMemo(() => new TypeId('organization', orgId), [orgId]);
  const { data: org } = useEntity<APIEntity<any>>(orgTypeId);
  const { members, ready, refresh } = useMembers(orgTypeId);
  const OrgIcon = iconForType('organization');

  // The caller's own member row drives the invite gate (the hub re-checks
  // server-side, so a spoofed client can't actually over-invite).
  const me = useMemo(
    () => members.find((m) => m.user_id === user.id) ?? null,
    [members, user.id],
  );
  const canInvite = canInviteMembers(me as any);

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center gap-2">
        <OrgIcon className="h-5 w-5" />
        <div className="text-base font-semibold">{(org as any)?.name || t`Organization`}</div>
      </div>

      <MemberSection
        title={t`Members`}
        members={members}
        ready={ready}
        selfId={user.id}
        invite={
          canInvite
            ? { entityTypeId: orgTypeId, onInvited: () => void refresh() }
            : undefined
        }
      />

      <TeamsSection user={user} />
    </div>
  );
}

function TeamsSection({ user }: { user: User }) {
  // Teams the client knows about (materialized remote=True when the user
  // accepted a team invitation). The hub login returns only the organization,
  // so this is "teams seen locally", not necessarily every team on the hub.
  const request = useMemo(() => new QueryRequest({ type: 'team', query: {} }), []);
  const { data: teams } = useEntitiesQuery<APIEntity<any>>(request);
  const list = teams ?? [];
  if (list.length === 0) return null;
  return (
    <div className="flex flex-col gap-3">
      <div className="text-sm font-semibold text-muted-foreground"><Trans>Teams</Trans></div>
      {list.map((team) => (
        <TeamRow key={team.id} team={team} selfId={user.id} />
      ))}
    </div>
  );
}

function TeamRow({ team, selfId }: { team: APIEntity<any>; selfId: string }) {
  const { t } = useLingui();
  const teamTypeId = useMemo(() => new TypeId('team', team.id), [team.id]);
  const { members, ready } = useMembers(teamTypeId);
  const TeamIcon = iconForType('team');
  return (
    <div className="rounded-md border p-3">
      <div className="mb-2 flex items-center gap-2">
        <TeamIcon className="h-4 w-4" />
        <div className="text-sm font-medium">{(team as any).name || t`Team`}</div>
      </div>
      <MemberSection members={members} ready={ready} selfId={selfId} compact />
    </div>
  );
}

function MemberSection({
  title,
  members,
  ready,
  selfId,
  invite,
  compact,
}: {
  title?: string;
  members: EntityMember[];
  ready: boolean;
  selfId: string;
  invite?: { entityTypeId: TypeId; onInvited: () => void };
  compact?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      {title && <div className="text-sm font-semibold text-muted-foreground">{title}</div>}
      {!ready && members.length === 0 ? (
        <div className="text-sm text-muted-foreground"><Trans>Loading members…</Trans></div>
      ) : members.length === 0 ? (
        <div className="text-sm text-muted-foreground"><Trans>No members yet.</Trans></div>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {members.map((m, i) => (
            <MemberRow key={m.user_id ?? m.email ?? i} member={m} isSelf={m.user_id === selfId} />
          ))}
        </ul>
      )}
      {invite && !compact && <InviteBox entityTypeId={invite.entityTypeId} onInvited={invite.onInvited} />}
    </div>
  );
}

function MemberRow({ member, isSelf }: { member: EntityMember; isSelf: boolean }) {
  const color = avatarColorForParticipant(member as any);
  const label = participantLabel(member as any);
  const initials = participantInitials(member as any);
  const role = participantRoleLabel(member as any);
  const pending = (member.status || '').toLowerCase() === 'pending';
  return (
    <li className="flex items-center gap-2">
      <span
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white ${color}`}
      >
        {initials}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm">
        {label}
        {isSelf && <span className="text-muted-foreground"><Trans> (you)</Trans></span>}
      </span>
      {role && <span className="text-xs text-muted-foreground">{role}</span>}
      {pending && <span className="text-xs italic text-muted-foreground"><Trans>pending</Trans></span>}
    </li>
  );
}

function InviteBox({ entityTypeId, onInvited }: { entityTypeId: TypeId; onInvited: () => void }) {
  const { t } = useLingui();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = useCallback(async () => {
    const trimmed = normalizeEmail(email) || '';
    if (!trimmed) return;
    setBusy(true);
    try {
      const { dataManager } = await import('@sdk');
      const entity = await dataManager.getByTypeId<any>(entityTypeId);
      if (!entity || typeof entity.inviteMember !== 'function') {
        throw new Error('Organization not loaded');
      }
      await entity.inviteMember(trimmed, 'member');
      setEmail('');
      notify.success({ title: t`Invitation sent`, message: t`Invited ${trimmed}.`, id: 'org-invite' });
      onInvited();
    } catch (err) {
      notify.error({
        title: t`Invite failed`,
        message: err instanceof Error ? err.message : t`Unknown error.`,
        id: 'org-invite',
      });
    } finally {
      setBusy(false);
    }
  }, [email, entityTypeId, onInvited, t]);

  return (
    <div className="mt-1 flex items-center gap-2">
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit();
        }}
        placeholder={t`Invite by email…`}
        className="min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 py-1 text-sm"
      />
      <Button size="sm" disabled={busy || !email.trim()} onClick={() => void submit()}>
        {busy && <Loader2 className="h-4 w-4 animate-spin" />}
        <Trans>Invite</Trans>
      </Button>
    </div>
  );
}
