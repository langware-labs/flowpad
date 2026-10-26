/**
 * Members: everyone in the organization in one table — the people on each team plus those on
 * none — with the teams they are on and their total spend. "No team" and "Pending" are filters,
 * not separate sections.
 *
 * Built from the reads the page already has: `people` (the org's own, teamless) from the org read
 * and one `teamBudgets` per team, fetched only while this tab is open.
 */
import { TypeId, budgetsService, type OrgBudgets, type TeamBudgets } from '@sdk';
import { useQueries } from '@tanstack/react-query';
import { MoreHorizontal } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

import { useLocalUser } from '@src/components/conversation/useLocalUser';
import { formatUsd } from '@src/components/llm-endpoints/usage-math';
import { InviteRow } from '@src/components/organization/invite-row';
import {
  teamBudgetsKey,
  useInvalidateBudgets,
  useRemoveTeamMember,
} from '@src/components/organization/budgets/use-budgets';
import { isGroupMember } from '@src/components/organization/member-roles';
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
import { cn } from '@src/lib/utils';
import { notify } from '@src/notifications';

import { Loading, TabTitle } from './shared';

type Filter = 'all' | 'no-team' | 'pending';

export interface OrgMemberRow {
  key: string;
  user_id: string | null;
  name: string;
  email: string | null;
  teams: string[];
  /** Each team this person is on, and whether the caller may remove them from it (hub's per-row answer). */
  memberships: { teamId: string; teamName: string; canRemove: boolean }[];
  role: string | null;
  spent: number;
  pending: boolean;
}

/** Everyone, once: team rosters merged by person, plus the org's teamless people. */
export function mergeOrgMembers(
  data: Pick<OrgBudgets, 'people' | 'teams'>,
  rosters: readonly (TeamBudgets | undefined)[],
  orgRoles: ReadonlyMap<string, string>,
): OrgMemberRow[] {
  const rows = new Map<string, OrgMemberRow>();
  rosters.forEach((roster, i) => {
    const team = data.teams[i];
    const teamName = team?.name ?? '';
    for (const m of roster?.members ?? []) {
      const key = m.user_id ?? m.email ?? m.endpoint_id;
      const row = rows.get(key) ?? {
        key,
        user_id: m.user_id,
        name: m.name,
        email: m.email,
        teams: [],
        memberships: [],
        role: m.user_id ? (orgRoles.get(m.user_id) ?? null) : null,
        spent: 0,
        pending: !m.user_id,
      };
      if (!row.teams.includes(teamName)) row.teams.push(teamName);
      if (team && !row.memberships.some((x) => x.teamId === team.id))
        row.memberships.push({ teamId: team.id, teamName, canRemove: m.can_remove });
      row.spent += m.spent_usd;
      rows.set(key, row);
    }
  });
  for (const p of data.people ?? []) {
    if (rows.has(p.user_id)) continue;
    rows.set(p.user_id, {
      key: p.user_id,
      user_id: p.user_id,
      name: p.name,
      email: p.email,
      teams: [],
      memberships: [],
      role: p.role,
      spent: 0,
      pending: false,
    });
  }
  return [...rows.values()].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

const GRID = 'grid grid-cols-[minmax(0,1fr)_minmax(0,12rem)_7rem_6rem_2rem] items-center gap-3 px-4';

/** What the confirm dialog is about to do: leave one team, or leave the whole organization. */
type Removal = { row: OrgMemberRow; teamId: string; teamName: string } | { row: OrgMemberRow; teamId: null };

export function MembersTab({ data }: { data: OrgBudgets }) {
  const { t } = useLingui();
  const { localUser } = useLocalUser();
  const orgTypeId = useMemo(() => new TypeId('organization', data.org.id), [data.org.id]);
  const { members: orgRoster, refresh, removeMember: removeFromOrg } = useMembers(orgTypeId);
  const removeFromTeam = useRemoveTeamMember();
  const invalidateBudgets = useInvalidateBudgets();
  const [removing, setRemoving] = useState<Removal | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [inviting, setInviting] = useState(false);

  const rosterQueries = useQueries({
    queries: data.teams.map((team) => ({
      queryKey: teamBudgetsKey(team.id),
      queryFn: () => budgetsService.teamBudgets(team.id),
      staleTime: 15_000,
      retry: false,
    })),
  });
  const loading = rosterQueries.some((q) => q.isLoading);
  const orgRoles = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of orgRoster) if (!isGroupMember(m as never) && m.user_id && m.role) map.set(m.user_id, m.role);
    return map;
  }, [orgRoster]);
  const me = orgRoster.find((m) => !!m.user_id && m.user_id === localUser?.id) ?? null;
  const rosters = rosterQueries.map((q) => q.data);
  const rows = useMemo(
    () => mergeOrgMembers(data, rosters, orgRoles),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `rosters` is rebuilt every render; its contents are tracked by dataUpdatedAt
    [data, orgRoles, ...rosterQueries.map((q) => q.dataUpdatedAt)],
  );

  const counts = {
    all: rows.length,
    'no-team': rows.filter((r) => r.teams.length === 0).length,
    pending: rows.filter((r) => r.pending).length,
  };
  const needle = query.trim().toLowerCase();
  const shown = rows.filter(
    (r) =>
      (filter === 'all' || (filter === 'no-team' ? r.teams.length === 0 : r.pending)) &&
      (!needle || r.name.toLowerCase().includes(needle) || (r.email ?? '').toLowerCase().includes(needle)),
  );
  const remove = async ({ row, teamId }: Removal) => {
    if (!row.user_id) return;
    const userId = row.user_id;
    try {
      if (teamId) {
        await removeFromTeam.mutateAsync({ teamId, userId });
      } else {
        // Out of every team first, so nobody is left on a team of an org they no longer belong to.
        for (const m of row.memberships) await removeFromTeam.mutateAsync({ teamId: m.teamId, userId });
        await removeFromOrg(userId);
        await invalidateBudgets();
      }
    } catch (e) {
      notify.error({ title: t`Could not remove ${row.name}`, message: errorMessage(e, ''), id: 'org-member-remove' });
    }
  };

  const chips: [Filter, React.ReactNode][] = [
    ['all', <Trans key="a">All</Trans>],
    ['no-team', <Trans key="n">No team</Trans>],
    ['pending', <Trans key="p">Pending</Trans>],
  ];

  return (
    <div data-testid="org-members-tab">
      <TabTitle
        title={<Trans>Members</Trans>}
        sub={<Trans>Everyone in {data.org.name}.</Trans>}
        action={
          data.org.can_invite && (
            <Button size="sm" onClick={() => setInviting((v) => !v)} data-testid="org-invite-open">
              <Trans>+ Invite people</Trans>
            </Button>
          )
        }
      />
      {inviting && (
        <div className="mb-4 rounded-lg border border-border px-4 py-3">
          <InviteRow entityTypeId={orgTypeId} onInvited={() => void refresh()} me={me} testIdPrefix="org" />
        </div>
      )}
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t`Search people…`}
          data-testid="org-members-search"
          className="w-64 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm"
        />
        <div className="flex gap-1 rounded-md border border-border p-0.5 text-sm" role="tablist">
          {chips.map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={filter === id}
              onClick={() => setFilter(id)}
              data-testid={`org-members-filter-${id}`}
              className={cn(
                'rounded px-2 py-0.5',
                filter === id ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {label} <span className="tabular-nums">{counts[id]}</span>
            </button>
          ))}
        </div>
      </div>

      <section className="overflow-hidden rounded-lg border border-border" data-testid="org-members-table">
        <div
          className={`${GRID} border-b border-border py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground max-sm:hidden`}
        >
          <span>
            <Trans>Person</Trans>
          </span>
          <span>
            <Trans>Teams</Trans>
          </span>
          <span>
            <Trans>Org role</Trans>
          </span>
          <span className="text-end">
            <Trans>Spent</Trans>
          </span>
          <span />
        </div>
        {loading ? (
          <div className="px-4">
            <Loading />
          </div>
        ) : shown.length === 0 ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">
            <Trans>Nobody here.</Trans>
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {shown.map((r) => (
              <li key={r.key} className={`${GRID} py-3 hover:bg-muted/40`} data-testid={`org-person-${r.key}`}>
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/20 text-[11px] font-semibold text-primary">
                    {(r.name || r.email || '?').charAt(0).toUpperCase()}
                  </span>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">
                      {r.name}
                      {r.user_id && r.user_id === localUser?.id && (
                        <span className="text-muted-foreground">
                          {' '}
                          <Trans>(you)</Trans>
                        </span>
                      )}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">{r.email ?? ''}</div>
                  </div>
                </div>
                <span className="truncate text-sm">
                  {r.teams.length ? (
                    r.teams.join(', ')
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      <Trans>No team</Trans>
                    </span>
                  )}
                </span>
                <span>
                  {r.pending ? (
                    <Badge variant="secondary" className="font-normal">
                      <Trans>Pending</Trans>
                    </Badge>
                  ) : r.role ? (
                    <Badge variant="outline" className="font-normal capitalize">
                      {r.role}
                    </Badge>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </span>
                <span className="text-end text-sm tabular-nums">{formatUsd(r.spent)}</span>
                <RowMenu
                  row={r}
                  canRemoveFromOrg={
                    data.org.can_invite && !!r.user_id && r.user_id !== localUser?.id && r.role !== 'owner'
                  }
                  onRemove={setRemoving}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        variant="destructive"
        title={
          removing?.teamId
            ? t`Remove ${removing.row.name} from ${removing.teamName}?`
            : t`Remove ${removing?.row.name ?? ''} from ${data.org.name}?`
        }
        description={
          removing?.teamId
            ? t`They will leave ${removing.teamName} and lose the budget it gave them. Money already spent is not affected.`
            : t`They will leave ${data.org.name} and every team in it, and lose the budgets those gave them. Money already spent is not affected.`
        }
        confirmLabel={t`Remove`}
        onConfirm={() => {
          if (!removing) return;
          const target = removing;
          setRemoving(null);
          void remove(target);
        }}
      />
    </div>
  );
}

function RowMenu({
  row,
  canRemoveFromOrg,
  onRemove,
}: {
  row: OrgMemberRow;
  canRemoveFromOrg: boolean;
  onRemove: (removal: Removal) => void;
}) {
  const { t } = useLingui();
  const teams = row.user_id ? row.memberships.filter((m) => m.canRemove) : [];
  if (!canRemoveFromOrg && teams.length === 0) return <span />;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="ghost" aria-label={t`More`} data-testid={`org-person-more-${row.key}`}>
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {teams.map((m) => (
          <DropdownMenuItem
            key={m.teamId}
            onSelect={() => onRemove({ row, teamId: m.teamId, teamName: m.teamName })}
            data-testid={`org-person-remove-team-${row.key}-${m.teamId}`}
          >
            <Trans>Remove from {m.teamName}</Trans>
          </DropdownMenuItem>
        ))}
        {canRemoveFromOrg && (
          <DropdownMenuItem
            className="text-destructive"
            onSelect={() => onRemove({ row, teamId: null })}
            data-testid={`org-person-remove-org-${row.key}`}
          >
            <Trans>Remove from organization</Trans>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
