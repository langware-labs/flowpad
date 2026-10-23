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
import { useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

import { useLocalUser } from '@src/components/conversation/useLocalUser';
import { formatUsd } from '@src/components/llm-endpoints/usage-math';
import { InviteRow } from '@src/components/organization/invite-row';
import { teamBudgetsKey } from '@src/components/organization/budgets/use-budgets';
import { isGroupMember } from '@src/components/organization/member-roles';
import { Badge } from '@src/components/ui/badge';
import { Button } from '@src/components/ui/button';
import { useMembers } from '@src/hooks/use-members';
import { cn } from '@src/lib/utils';

import { Loading, TabTitle } from './shared';

type Filter = 'all' | 'no-team' | 'pending';

export interface OrgMemberRow {
  key: string;
  user_id: string | null;
  name: string;
  email: string | null;
  teams: string[];
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
    const teamName = data.teams[i]?.name ?? '';
    for (const m of roster?.members ?? []) {
      const key = m.user_id ?? m.email ?? m.endpoint_id;
      const row = rows.get(key) ?? {
        key,
        user_id: m.user_id,
        name: m.name,
        email: m.email,
        teams: [],
        role: m.user_id ? (orgRoles.get(m.user_id) ?? null) : null,
        spent: 0,
        pending: !m.user_id,
      };
      if (!row.teams.includes(teamName)) row.teams.push(teamName);
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
      role: p.role,
      spent: 0,
      pending: false,
    });
  }
  return [...rows.values()].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

const GRID = 'grid grid-cols-[minmax(0,1fr)_minmax(0,12rem)_7rem_6rem] items-center gap-3 px-4';

export function MembersTab({ data }: { data: OrgBudgets }) {
  const { t } = useLingui();
  const { localUser } = useLocalUser();
  const orgTypeId = useMemo(() => new TypeId('organization', data.org.id), [data.org.id]);
  const { members: orgRoster, refresh } = useMembers(orgTypeId);
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
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
