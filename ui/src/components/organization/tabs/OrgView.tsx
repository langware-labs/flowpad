/**
 * One organization: tabs Teams | Members | Billing & keys | General, or a team's own page.
 *
 * Every control is gated on what the hub says the caller may press (`can_*` on the budgets read),
 * never on a role read here. A caller the budgets read refuses (a plain member, 401/403) gets
 * `MemberOrgCard`: the org's name and the teams they are on, no money and no tabs.
 */
import { QueryRequest, Team } from '@sdk';
import { Users } from 'lucide-react';
import { useMemo } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

import { useOrgBudgets, useInvalidateBudgets } from '@src/components/organization/budgets/use-budgets';
import { Button } from '@src/components/ui/button';
import { useEntitiesQuery } from '@src/hooks/entity-hooks/useEntitiesQuery';
import { cn } from '@src/lib/utils';

import { BillingTab } from './BillingTab';
import { GeneralTab } from './GeneralTab';
import { MembersTab } from './MembersTab';
import { TeamDetail } from './TeamDetail';
import { TeamsTab } from './TeamsTab';
import type { OrgTab } from './org-route';
import { Loading } from './shared';

function statusOf(error: unknown): number | null {
  const status = (error as { response?: { status?: unknown } } | null)?.response?.status;
  return typeof status === 'number' ? status : null;
}

export function OrgView({
  orgId,
  name,
  tab,
  teamId,
  onTab,
  onOpenTeam,
  onCloseTeam,
  onDeleted,
}: {
  orgId: string;
  name?: string;
  tab: OrgTab;
  teamId: string | null;
  onTab: (tab: OrgTab) => void;
  onOpenTeam: (teamId: string) => void;
  onCloseTeam: () => void;
  onDeleted: () => void;
}) {
  const { t } = useLingui();
  const { data, isLoading, error, refetch } = useOrgBudgets(orgId);
  const invalidate = useInvalidateBudgets();
  const changed = () => void invalidate();

  if (error) {
    const status = statusOf(error);
    return status === 401 || status === 403 ? (
      <MemberOrgCard name={name} />
    ) : (
      <Unreadable onRetry={() => void refetch()} />
    );
  }
  if (isLoading) return <Loading label={<Trans>Loading budgets…</Trans>} />;
  if (!data?.org) return <Unreadable onRetry={() => void refetch()} />;

  const team = teamId ? data.teams.find((x) => x.id === teamId) : undefined;
  const tabs: [OrgTab, string][] = [
    ['teams', t`Teams`],
    ['members', t`Members`],
    ['billing', t`Billing & keys`],
    ['general', t`General`],
  ];

  return (
    <div data-testid="org-unit">
      <nav className="mb-6 flex gap-1 border-b border-border" role="tablist" data-testid="org-tabs">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => onTab(id)}
            data-testid={`org-tab-${id}`}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm',
              tab === id
                ? 'border-primary font-medium text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === 'teams' && team ? (
        <TeamDetail key={team.id} team={team} onBack={onCloseTeam} onChanged={changed} />
      ) : tab === 'teams' ? (
        <TeamsTab data={data} onChanged={changed} onOpenTeam={onOpenTeam} onOpenBilling={() => onTab('billing')} />
      ) : tab === 'members' ? (
        <MembersTab data={data} />
      ) : tab === 'billing' ? (
        <BillingTab data={data} />
      ) : (
        <GeneralTab data={data} onChanged={changed} onDeleted={onDeleted} />
      )}
    </div>
  );
}

/**
 * What a plain MEMBER sees: the org's name and the teams they are on. The team query is scoped to
 * the caller by the hub, so it answers with THEIR teams. No money, no controls.
 */
function MemberOrgCard({ name }: { name?: string }) {
  const { t } = useLingui();
  const teamsQuery = useMemo(() => new QueryRequest({ type: Team.type, query: {} }), []);
  const { data: teams, isLoading } = useEntitiesQuery<Team>(teamsQuery);
  const mine = Array.isArray(teams) ? teams : [];
  return (
    <section className="rounded-lg border border-border" data-testid="org-unit" data-readonly="true">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-lg font-semibold" data-testid="org-name">
          {name || t`Organization`}
        </h2>
      </div>
      <div className="px-4 py-3" data-testid="org-member-teams">
        {isLoading ? (
          <Loading />
        ) : mine.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            <Trans>You are not on any team yet.</Trans>
          </p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {mine.map((team) => (
              <li key={team.id} className="flex items-center gap-2" data-testid={`org-member-team-${team.id}`}>
                <Users className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                {team.name}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function Unreadable({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      data-testid="org-unit-unreadable"
      className="flex flex-wrap items-center gap-3 rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground"
    >
      <span>
        <Trans>This organization's budgets could not be read.</Trans>
      </span>
      <Button size="sm" variant="outline" onClick={onRetry}>
        <Trans>Try again</Trans>
      </Button>
    </div>
  );
}
