/**
 * One team: its money in three boxes, then its people. Opened from a row on the Teams tab
 * (`/dock/hub/organization/team/<id>`).
 *
 * A person's limit says where it comes from: "team default" when it equals the team's default per
 * person, "custom" otherwise, with a one-click reset back to the default. Removing a PERSON takes
 * them off the team (the hub drops their allowance with the membership); a row nobody holds yet
 * deletes the allowance itself.
 */
import { TypeId, dataManager, type LLMEndpoint, type MemberBudget, type ScopeBudget } from '@sdk';
import { ChevronLeft, Loader2, MoreHorizontal, RotateCcw, Send, UserPlus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Plural, Trans, useLingui } from '@lingui/react/macro';

import { useLocalUser } from '@src/components/conversation/useLocalUser';
import { useLlmEndpoint, useLlmEndpoints } from '@src/components/llm-endpoints/use-llm-endpoints';
import { formatUsd } from '@src/components/llm-endpoints/usage-math';
import { isGroupMember } from '@src/components/organization/member-roles';
import { AddPeopleDialog } from '@src/components/organization/budgets/AddPeopleDialog';
import { AdvancedEndpointDialog } from '@src/components/organization/budgets/AdvancedEndpointDialog';
import { BudgetHistoryDialog } from '@src/components/organization/budgets/BudgetHistoryDialog';
import { EditableTitle } from '@src/components/organization/budgets/EditableTitle';
import { EndpointControls } from '@src/components/organization/budgets/EndpointControls';
import { inviteToTeamByEmail } from '@src/components/organization/budgets/invite-to-team';
import { MoneyBox } from '@src/components/organization/budgets/MoneyBox';
import { renameEntity } from '@src/components/organization/budgets/rename-entity';
import { ShareProjectButton } from '@src/components/organization/budgets/ShareProjectPanel';
import {
  useInvalidateBudgets,
  useRemoveAllowance,
  useRemoveTeamMember,
  useSetLifetimeCap,
  useTeamBudgets,
} from '@src/components/organization/budgets/use-budgets';
import { useSetupScope } from '@src/components/token-plan/use-token-plan';
import { Badge } from '@src/components/ui/badge';
import { Button } from '@src/components/ui/button';
import { ConfirmDialog } from '@src/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@src/components/ui/dropdown-menu';
import { useMembers } from '@src/hooks/use-members';
import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';

import { Loading, SpendBar, savingCap } from './shared';

const PEOPLE_GRID = 'grid grid-cols-[minmax(0,1fr)_7rem_6rem_13rem_2rem] items-center gap-3 px-4';

export function TeamDetail({
  team,
  onBack,
  onChanged,
}: {
  team: ScopeBudget;
  onBack: () => void;
  onChanged: () => void;
}) {
  const { t } = useLingui();
  const teamTypeId = useMemo(() => new TypeId('team', team.id), [team.id]);
  const detail = useTeamBudgets(team.id);
  const pool = useLlmEndpoint(team.endpoint_id);
  const { refetch: refetchEndpoints } = useLlmEndpoints();
  const { members: roster, refresh: refreshRoster } = useMembers(teamTypeId);
  const setCap = useSetLifetimeCap();
  const removeAllowance = useRemoveAllowance();
  const removeMember = useRemoveTeamMember();
  const invalidate = useInvalidateBudgets();
  const setup = useSetupScope();
  const [adding, setAdding] = useState(false);
  const [menu, setMenu] = useState<'history' | 'advanced' | 'delete' | null>(null);
  const [removing, setRemoving] = useState<MemberBudget | null>(null);
  const [deleting, setDeleting] = useState(false);

  const roleByUser = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of roster) if (!isGroupMember(m as never) && m.user_id && m.role) map.set(m.user_id, m.role);
    return map;
  }, [roster]);
  // `undefined` until the team's pool has loaded: before that nobody can be called default or custom.
  const defaultCap = pool ? (pool.member_default_limits?.cost_usd_total ?? null) : undefined;
  const members = detail.data?.members ?? [];
  const poolId = team.endpoint_id;

  const setDefault = async (usd: number | null) => {
    if (!pool) return;
    try {
      await dataManager.save<LLMEndpoint>(pool.typeId, [], {
        member_default_limits: { ...pool.member_default_limits, cost_usd_total: usd },
      } as never);
      void invalidate();
    } catch (e) {
      notify.error({ title: t`Could not save the default`, message: errorMessage(e, ''), id: 'team-default' });
    }
  };

  const invite = async (email: string) => {
    const outcome = await inviteToTeamByEmail(team.id, [email]);
    if (outcome.invited.length) notify.success({ title: t`Invitation sent`, message: email, id: 'team-invite' });
    else if (outcome.already.length) notify.info({ title: t`Already on ${team.name}`, id: 'team-invite' });
    else notify.error({ title: t`Could not invite ${email}`, message: outcome.failed[0]?.reason, id: 'team-invite' });
  };

  const capError = (e: unknown) =>
    notify.error({ title: t`Could not save the budget`, message: errorMessage(e, ''), id: 'budget-cap' });

  const deleteTeam = async () => {
    setDeleting(true);
    try {
      // Load it as an entity first: `dataManager.delete` is cache-first and this row came from
      // the budgets aggregate, not the entity cache.
      await dataManager.getByTypeId(teamTypeId);
      await dataManager.delete(teamTypeId);
      onChanged();
      onBack();
    } catch (e) {
      notify.error({ title: t`Could not delete ${team.name}`, message: errorMessage(e, ''), id: 'team-delete' });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div data-testid={`team-detail-${team.id}`}>
      <button
        type="button"
        onClick={onBack}
        className="mb-2 flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        data-testid="team-detail-back"
      >
        <ChevronLeft className="h-4 w-4" />
        <Trans>Teams</Trans>
        <span className="text-muted-foreground">›</span>
        <span>{team.name}</span>
      </button>

      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <EditableTitle
            name={team.name}
            onRename={async (next) => {
              await renameEntity(teamTypeId, next);
              onChanged();
            }}
            onDelete={() => setMenu('delete')}
            deleting={deleting}
            manage={team.can_manage}
            copyId={team.id}
            headingClassName="text-lg font-semibold"
            testIdPrefix={`team-${team.id}`}
          />
          <p className="text-sm text-muted-foreground">
            {team.member_count != null && <Plural value={team.member_count} one="# member" other="# members" />}
            {team.my_role && (
              <>
                {' · '}
                <Trans>you are {team.my_role}</Trans>
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {team.can_allocate && <ShareProjectButton teamId={team.id} teamName={team.name} />}
          {poolId && team.can_allocate && (
            <Button
              size="sm"
              onClick={() => setAdding(true)}
              disabled={!detail.data}
              data-testid={`team-add-people-${team.id}`}
            >
              <UserPlus className="h-4 w-4" />
              <Trans>Add people</Trans>
            </Button>
          )}
          {poolId && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline" aria-label={t`More`} data-testid={`team-more-${team.id}`}>
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {team.can_configure && (
                  <DropdownMenuItem onSelect={() => setMenu('history')} data-testid={`team-history-${team.id}`}>
                    <Trans>Budget history</Trans>
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onSelect={() => setMenu('advanced')} data-testid={`team-advanced-${team.id}`}>
                  <Trans>Advanced limits</Trans>
                </DropdownMenuItem>
                {team.can_manage && (
                  <DropdownMenuItem
                    className="text-destructive"
                    onSelect={() => setMenu('delete')}
                    data-testid={`team-delete-menu-${team.id}`}
                  >
                    <Trans>Delete team</Trans>
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {!poolId ? (
        <div className="flex items-center gap-3 rounded-lg border border-dashed border-border px-4 py-4 text-sm">
          <span className="text-muted-foreground">
            <Trans>This team has no budget yet.</Trans>
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={setup.isPending}
            data-testid={`budget-setup-team-${team.id}`}
            onClick={() =>
              setup.mutate(
                { kind: 'team', id: team.id },
                {
                  // The new pool is not in the cached endpoint list yet; its cap and default
                  // boxes save through that cache, so read it again.
                  onSuccess: () => {
                    void refetchEndpoints();
                    onChanged();
                  },
                  onError: (e) =>
                    notify.error({
                      title: t`Could not create the budget`,
                      message: errorMessage(e, ''),
                      id: 'budget-setup',
                    }),
                },
              )
            }
          >
            {setup.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            <Trans>Set up budget</Trans>
          </Button>
        </div>
      ) : (
        <>
          <div className="mb-5 grid gap-3 sm:grid-cols-3">
            <Stat label={<Trans>Spent / limit</Trans>}>
              <div className="flex items-center justify-between gap-2">
                <MoneyBox
                  value={team.limit_usd}
                  ariaLabel={t`Budget for ${team.name}`}
                  data-testid={`team-cap-${team.id}`}
                  disabled={savingCap(setCap, poolId) || !team.can_configure}
                  onCommit={(usd) =>
                    setCap.mutate({ endpointId: poolId, usd }, { onSuccess: onChanged, onError: capError })
                  }
                />
                <SpendBar spent={team.spent_usd} limit={team.limit_usd} />
              </div>
              {team.allocated_usd !== null && team.limit_usd !== null && team.allocated_usd > team.limit_usd && (
                <p className="mt-1 text-xs text-destructive" data-testid={`team-over-allocated-${team.id}`}>
                  <Trans>More is given out than this budget holds.</Trans>
                </p>
              )}
            </Stat>
            <Stat label={<Trans>Default per person</Trans>}>
              <MoneyBox
                value={defaultCap ?? null}
                ariaLabel={t`Default budget per person in ${team.name}`}
                data-testid={`team-default-cap-${team.id}`}
                disabled={!pool || !team.can_configure}
                onCommit={(usd) => void setDefault(usd)}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                <Trans>People without their own limit get this.</Trans>
              </p>
            </Stat>
            <Stat label={<Trans>Models &amp; status</Trans>}>
              <EndpointControls
                endpointId={poolId}
                scope="team"
                testIdPrefix={`team-${team.id}`}
                manage={team.can_configure}
              />
            </Stat>
          </div>

          <section className="overflow-hidden rounded-lg border border-border" data-testid={`team-people-${team.id}`}>
            <div
              className={`${PEOPLE_GRID} border-b border-border py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground max-sm:hidden`}
            >
              <span>
                <Trans>Person</Trans>
              </span>
              <span>
                <Trans>Role</Trans>
              </span>
              <span>
                <Trans>Spent</Trans>
              </span>
              <span>
                <Trans>Limit</Trans>
              </span>
              <span />
            </div>
            {detail.isLoading || !detail.data ? (
              <div className="px-4">
                <Loading />
              </div>
            ) : members.length === 0 ? (
              <p className="px-4 py-3 text-sm text-muted-foreground">
                <Trans>Nobody has a budget in this team yet.</Trans>
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {members.map((member) => (
                  <PersonRow
                    key={member.endpoint_id}
                    member={member}
                    role={member.user_id ? roleByUser.get(member.user_id) : undefined}
                    defaultCap={defaultCap}
                    capPending={savingCap(setCap, member.endpoint_id)}
                    canInvite={team.can_allocate}
                    onSetCap={(usd) => setCap.mutate({ endpointId: member.endpoint_id, usd }, { onError: capError })}
                    onInvite={() => member.email && void invite(member.email)}
                    onRemove={() => setRemoving(member)}
                  />
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      {poolId && adding && detail.data && (
        <AddPeopleDialog
          open
          onOpenChange={(open) => {
            setAdding(open);
            // New people hold a role on the team now; the roster that names their role is read again.
            if (!open) void refreshRoster();
          }}
          poolId={poolId}
          teamId={team.id}
          teamName={team.name}
          existing={detail.data.members}
        />
      )}
      {poolId && (
        <>
          <BudgetHistoryDialog
            open={menu === 'history'}
            onOpenChange={(o) => !o && setMenu(null)}
            endpointId={poolId}
            scopeLabel={team.name}
          />
          <AdvancedEndpointDialog
            open={menu === 'advanced'}
            onOpenChange={(o) => !o && setMenu(null)}
            endpointId={poolId}
            scopeLabel={team.name}
            readOnly={!team.can_configure}
          />
        </>
      )}

      <ConfirmDialog
        open={menu === 'delete'}
        onOpenChange={(o) => !o && setMenu(null)}
        variant="destructive"
        title={t`Delete ${team.name}?`}
        description={t`Everyone's budget inside ${team.name} is deleted with it. This cannot be undone.`}
        confirmLabel={t`Delete`}
        onConfirm={() => void deleteTeam()}
      />
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        variant="destructive"
        title={removing?.user_id ? t`Remove from ${team.name}?` : t`Remove this budget?`}
        description={
          removing?.user_id
            ? t`${removing?.name ?? ''} will leave ${team.name} and lose the budget it gave them. Money already spent is not affected.`
            : t`${removing?.name ?? ''} will no longer be able to spend from ${team.name}. Money already spent is not affected.`
        }
        confirmLabel={t`Remove`}
        onConfirm={() => {
          if (!removing) return;
          const target = removing;
          setRemoving(null);
          const onError = (e: unknown) =>
            notify.error({
              title: t`Could not remove ${target.name}`,
              message: errorMessage(e, ''),
              id: 'budget-remove',
            });
          if (target.user_id) removeMember.mutate({ teamId: team.id, userId: target.user_id }, { onError });
          else removeAllowance.mutate({ endpointId: target.endpoint_id }, { onError });
        }}
      />
    </div>
  );
}

function Stat({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border px-4 py-3">
      <div className="mb-1.5 text-xs text-muted-foreground">{label}</div>
      {children}
    </div>
  );
}

function PersonRow({
  member,
  role,
  defaultCap,
  capPending,
  canInvite,
  onSetCap,
  onInvite,
  onRemove,
}: {
  member: MemberBudget;
  role?: string;
  defaultCap: number | null | undefined;
  capPending: boolean;
  canInvite: boolean;
  onSetCap: (usd: number | null) => void;
  onInvite: () => void;
  onRemove: () => void;
}) {
  const { t } = useLingui();
  const { localUser } = useLocalUser();
  const [advanced, setAdvanced] = useState(false);
  const isDefault = member.limit_usd === defaultCap;
  const isMe = !!member.user_id && member.user_id === localUser?.id;
  const removable = member.user_id ? member.can_remove : true;

  return (
    <li className={`${PEOPLE_GRID} py-3 hover:bg-muted/40`} data-testid={`member-budget-${member.endpoint_id}`}>
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/20 text-[11px] font-semibold text-primary">
          {(member.name || member.email || '?').charAt(0).toUpperCase()}
        </span>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">
            {member.name}
            {isMe && (
              <span className="text-muted-foreground">
                {' '}
                <Trans>(you)</Trans>
              </span>
            )}
          </div>
          <div className="truncate text-xs text-muted-foreground">{member.email ?? ''}</div>
        </div>
      </div>
      <div>
        {member.user_id ? (
          role ? (
            <Badge variant="outline" className="font-normal capitalize">
              {role}
            </Badge>
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          )
        ) : (
          <Badge variant="secondary" className="font-normal" data-testid={`member-pending-${member.endpoint_id}`}>
            <Trans>Pending</Trans>
          </Badge>
        )}
      </div>
      <span className="text-sm tabular-nums" data-testid={`member-spent-${member.endpoint_id}`}>
        {formatUsd(member.spent_usd)}
      </span>
      <div className="flex items-center gap-2">
        <MoneyBox
          value={member.limit_usd}
          ariaLabel={t`Budget for ${member.name}`}
          data-testid={`member-cap-${member.endpoint_id}`}
          disabled={capPending || !member.can_configure}
          onCommit={onSetCap}
        />
        {defaultCap === undefined ? null : isDefault ? (
          <span className="text-xs text-muted-foreground" data-testid={`member-limit-source-${member.endpoint_id}`}>
            <Trans>team default</Trans>
          </span>
        ) : (
          <span
            className="flex items-center gap-1 text-xs text-muted-foreground"
            data-testid={`member-limit-source-${member.endpoint_id}`}
          >
            <Trans>custom</Trans>
            {member.can_configure && (
              <button
                type="button"
                title={t`Reset to the team default`}
                className="inline-flex items-center gap-0.5 text-primary hover:underline"
                onClick={() => onSetCap(defaultCap ?? null)}
                data-testid={`member-reset-${member.endpoint_id}`}
              >
                <RotateCcw className="h-3 w-3" />
                <Trans>reset</Trans>
              </button>
            )}
          </span>
        )}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            aria-label={t`More`}
            data-testid={`member-more-${member.endpoint_id}`}
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {canInvite && member.email && (
            <DropdownMenuItem onSelect={onInvite} data-testid={`member-invite-${member.endpoint_id}`}>
              <Send className="h-3.5 w-3.5" />
              <Trans>Send invite</Trans>
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => setAdvanced(true)} data-testid={`member-advanced-${member.endpoint_id}`}>
            <Trans>Advanced limits</Trans>
          </DropdownMenuItem>
          {removable && (
            <DropdownMenuItem
              className="text-destructive"
              onSelect={onRemove}
              data-testid={`member-remove-${member.endpoint_id}`}
            >
              {member.user_id ? <Trans>Remove from team</Trans> : <Trans>Delete budget</Trans>}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <AdvancedEndpointDialog
        open={advanced}
        onOpenChange={setAdvanced}
        endpointId={member.endpoint_id}
        scopeLabel={member.name}
        readOnly={!member.can_configure}
      />
    </li>
  );
}
