/**
 * Teams: the org's spend in one strip, then one scannable row per team — name, my role, head
 * count, spent / limit. A row opens the team. Everything else about a team (its people, its
 * budget knobs, rename, delete) lives on that team's own page, not on the row.
 */
import { TypeId, type OrgBudgets, type ScopeBudget } from '@sdk';
import { ChevronRight } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Plural, Trans, useLingui } from '@lingui/react/macro';

import { Badge } from '@src/components/ui/badge';
import { Progress } from '@src/components/ui/progress';
import { RATIO_TONE } from '@src/components/llm-endpoints/tone';
import { formatUsd, ratioTone } from '@src/components/llm-endpoints/usage-math';

import { CreateTeamInline, SpendBar, TabTitle } from './shared';

const TEAM_GRID = 'grid grid-cols-[minmax(0,1fr)_7rem_7rem_9rem_1.5rem] items-center gap-3 px-4';

export function TeamsTab({
  data,
  onChanged,
  onOpenTeam,
  onOpenBilling,
}: {
  data: OrgBudgets;
  onChanged: () => void;
  onOpenTeam: (teamId: string) => void;
  onOpenBilling: () => void;
}) {
  const { t } = useLingui();
  const { org, teams } = data;
  const orgTypeId = useMemo(() => new TypeId('organization', org.id), [org.id]);
  const [query, setQuery] = useState('');
  const [mineOnly, setMineOnly] = useState(false);

  const shown = teams.filter(
    (team) => (!mineOnly || !!team.my_roles?.length) && team.name.toLowerCase().includes(query.trim().toLowerCase()),
  );

  return (
    <div data-testid="org-teams-tab">
      <TabTitle
        title={<Trans>Teams</Trans>}
        sub={<Trans>Teams group people and share a budget.</Trans>}
        action={
          org.can_add_child && (
            <CreateTeamInline
              parentTypeId={orgTypeId}
              parentLabel={org.name}
              onCreated={onChanged}
              testIdPrefix="org-create-team"
            />
          )
        }
      />

      {org.endpoint_id && <OrgSpendStrip spent={org.spent_usd} limit={org.limit_usd} onOpenBilling={onOpenBilling} />}

      {teams.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="org-no-teams">
          <Trans>No teams yet.</Trans>
        </p>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t`Search teams…`}
              data-testid="org-teams-search"
              className="w-64 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm"
            />
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                checked={mineOnly}
                onChange={(e) => setMineOnly(e.target.checked)}
                data-testid="org-teams-mine"
              />
              <Trans>Only my teams</Trans>
            </label>
          </div>
          <section className="overflow-hidden rounded-lg border border-border" data-testid="org-teams-table">
            <div
              className={`${TEAM_GRID} border-b border-border py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground max-sm:hidden`}
            >
              <span>
                <Trans>Team</Trans>
              </span>
              <span>
                <Trans>My role</Trans>
              </span>
              <span>
                <Trans>Members</Trans>
              </span>
              <span className="text-end">
                <Trans>Spent / limit</Trans>
              </span>
              <span />
            </div>
            <ul className="divide-y divide-border">
              {shown.map((team) => (
                <TeamRow key={team.id} team={team} onOpen={() => onOpenTeam(team.id)} />
              ))}
              {shown.length === 0 && (
                <li className="px-4 py-3 text-sm text-muted-foreground">
                  <Trans>No team matches.</Trans>
                </li>
              )}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}

function OrgSpendStrip({
  spent,
  limit,
  onOpenBilling,
}: {
  spent: number;
  limit: number | null;
  onOpenBilling: () => void;
}) {
  const used = limit ? Math.min(1, spent / limit) : 0;
  return (
    <div
      className="mb-5 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-border px-4 py-3 text-sm"
      data-testid="org-spend-strip"
    >
      <span className="text-muted-foreground">
        <Trans>Organization spend</Trans>
      </span>
      {limit !== null && (
        <Progress value={used * 100} className={`h-1.5 w-40 bg-muted ${RATIO_TONE[ratioTone(used)].bar}`} />
      )}
      <span className="font-medium tabular-nums">
        {formatUsd(spent)}{' '}
        <span className="font-normal text-muted-foreground">/ {limit === null ? '∞' : formatUsd(limit)}</span>
      </span>
      <button
        type="button"
        className="ml-auto text-primary hover:underline"
        onClick={onOpenBilling}
        data-testid="org-open-billing"
      >
        <Trans>Billing &amp; keys →</Trans>
      </button>
    </div>
  );
}

function TeamRow({ team, onOpen }: { team: ScopeBudget; onOpen: () => void }) {
  return (
    <li
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => e.key === 'Enter' && onOpen()}
      className={`${TEAM_GRID} cursor-pointer py-3 hover:bg-muted/40`}
      data-testid={`team-unit-${team.id}`}
    >
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-sm font-semibold text-primary">
          {(team.name || '?').charAt(0).toUpperCase()}
        </span>
        <span className="truncate text-sm font-medium" data-testid={`team-${team.id}-name`}>
          {team.name}
        </span>
      </div>
      <div data-testid={`team-${team.id}-role`}>
        {team.my_roles?.length ? (
          <Badge variant="outline" className="font-normal capitalize">
            {team.my_roles?.join(', ')}
          </Badge>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </div>
      <div className="text-sm tabular-nums text-muted-foreground" data-testid={`team-${team.id}-members`}>
        {team.member_count == null ? '—' : <Plural value={team.member_count} one="# member" other="# members" />}
      </div>
      {team.endpoint_id ? (
        <SpendBar spent={team.spent_usd} limit={team.limit_usd} testId={`team-${team.id}-spend`} />
      ) : (
        <span className="text-end text-xs text-muted-foreground">
          <Trans>No budget</Trans>
        </span>
      )}
      <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
    </li>
  );
}
