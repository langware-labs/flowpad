import { QueryRequest, Team, TypeId, type ScopeBudget } from '@sdk';
import { Loader2, Plus } from 'lucide-react';
import { useMemo } from 'react';
import { Plural, Trans, useLingui } from '@lingui/react/macro';

import { useLocalUser } from '@src/components/conversation/useLocalUser';
import { formatUsd } from '@src/components/llm-endpoints/usage-math';
import { isGroupMember } from '@src/components/organization/member-roles';
import { useInvalidateBudgets, useOrgBudgets } from '@src/components/organization/budgets/use-budgets';
import { useCreateChildTeamForm } from '@src/components/organization/use-create-child-team';
import { Button } from '@src/components/ui/button';
import { useEntitiesQuery } from '@src/hooks/entity-hooks/useEntitiesQuery';
import { useMembers } from '@src/hooks/use-members';

interface TeamRowData {
  id: string;
  name: string;
  budget?: ScopeBudget;
}

/**
 * The selected organization's teams as one clean list: name, my role, member count, budget.
 *
 * Teams come from the org's budgets read. A plain member is refused that read, so for them the
 * list falls back to the teams the hub lets them see, without the money columns.
 */
export function OrgTeamsList({ orgId }: { orgId: string }) {
  const { t } = useLingui();
  const { data, isLoading, error } = useOrgBudgets(orgId);
  const invalidate = useInvalidateBudgets();
  const createTeam = useCreateChildTeamForm({
    parentTypeId: new TypeId('organization', orgId),
    parentLabel: data?.org?.name ?? '',
    isOrganization: true,
    organizationCreatedTitle: t`Team created`,
    onCreated: () => void invalidate(),
  });
  const teamsQuery = useMemo(() => new QueryRequest({ type: Team.type, query: {} }), []);
  const fallback = useEntitiesQuery<Team>(teamsQuery);

  const rows: TeamRowData[] = useMemo(() => {
    if (data?.teams) return data.teams.map((t) => ({ id: t.id, name: t.name, budget: t }));
    if (error && Array.isArray(fallback.data)) {
      return fallback.data.map((t) => ({ id: t.id, name: t.name ?? '' }));
    }
    return [];
  }, [data, error, fallback.data]);

  if (isLoading || (error && fallback.isLoading)) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        <Trans>Loading teams…</Trans>
      </div>
    );
  }

  const showMoney = !!data?.teams;

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card" data-testid="org-teams-list">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Trans>Teams</Trans>
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-normal tabular-nums text-muted-foreground">
            {rows.length}
          </span>
        </div>
        {data?.org?.can_add_child &&
          (createTeam.open ? (
            <div className="flex items-center gap-2">
              <input
                autoFocus
                value={createTeam.name}
                onChange={(e) => createTeam.setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void createTeam.submit();
                  if (e.key === 'Escape') createTeam.setOpen(false);
                }}
                placeholder={t`Team name…`}
                data-testid="teams-list-new-name"
                className="w-44 rounded-md border border-border bg-background px-2.5 py-1 text-sm"
              />
              <Button
                size="sm"
                disabled={createTeam.busy || !createTeam.name.trim()}
                onClick={() => void createTeam.submit()}
                data-testid="teams-list-new-submit"
              >
                {createTeam.busy && <Loader2 className="h-4 w-4 animate-spin" />}
                <Trans>Create</Trans>
              </Button>
            </div>
          ) : (
            <Button size="sm" variant="outline" onClick={() => createTeam.setOpen(true)} data-testid="teams-list-new">
              <Plus className="h-4 w-4" />
              <Trans>Add team</Trans>
            </Button>
          ))}
      </div>
      {rows.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          <Trans>No teams yet.</Trans>
        </p>
      ) : (
        <>
          <div className="grid grid-cols-[1fr_7rem_6rem_7rem] gap-3 border-b border-border px-4 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground max-sm:hidden">
            <span>
              <Trans>Team</Trans>
            </span>
            <span>
              <Trans>My role</Trans>
            </span>
            <span className="text-end">
              <Trans>Members</Trans>
            </span>
            <span className="text-end">{showMoney && <Trans>Spent / budget</Trans>}</span>
          </div>
          <ul className="divide-y divide-border">
            {rows.map((row) => (
              <TeamRow key={row.id} row={row} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function TeamRow({ row }: { row: TeamRowData }) {
  const { localUser } = useLocalUser();
  const typeId = useMemo(() => new TypeId('team', row.id), [row.id]);
  const { members, ready } = useMembers(typeId);
  const people = members.filter((m) => !isGroupMember(m as never));
  const me = people.find((m) => !!m.user_id && m.user_id === localUser?.id);
  const role = me?.role?.trim();
  const b = row.budget;
  const pct = b && b.limit_usd ? Math.min(100, (b.spent_usd / b.limit_usd) * 100) : null;

  return (
    <li
      className="grid grid-cols-[1fr_7rem_6rem_7rem] items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/40 max-sm:grid-cols-[1fr_auto]"
      data-testid={`org-team-row-${row.id}`}
    >
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-sm font-semibold text-primary">
          {(row.name || '?').charAt(0).toUpperCase()}
        </span>
        <span className="truncate text-sm font-medium">{row.name}</span>
      </div>
      <div className="max-sm:hidden">
        {role ? (
          <span className="rounded-full border border-border px-2 py-0.5 text-xs capitalize">{role}</span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </div>
      <div className="text-end text-sm tabular-nums text-muted-foreground">
        {ready ? <Plural value={people.length} one="# member" other="# members" /> : '…'}
      </div>
      <div className="text-end text-sm tabular-nums max-sm:hidden">
        {b && (
          <div className="flex flex-col items-end gap-1">
            <span>
              {formatUsd(b.spent_usd)}
              <span className="text-muted-foreground"> / {b.limit_usd === null ? '∞' : formatUsd(b.limit_usd)}</span>
            </span>
            {pct !== null && (
              <span className="h-1 w-20 overflow-hidden rounded-full bg-muted">
                <span
                  className={`block h-full ${pct >= 90 ? 'bg-destructive' : 'bg-primary'}`}
                  style={{ width: `${pct}%` }}
                />
              </span>
            )}
          </div>
        )}
      </div>
    </li>
  );
}
