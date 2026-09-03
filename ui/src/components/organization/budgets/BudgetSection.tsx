/**
 * The money half of People & teams: who can spend how much of the organization's budget.
 *
 * The plain version of `/dock/hub/llm-endpoints`. That screen is about provider keys, fallback
 * chains and nine limit fields per hop; this one answers the only question a paying customer's
 * admin has — how much has each team and each person got, and how much is left. One number per
 * row, editable in place.
 *
 * It follows the selection the tree already owns: an organization node shows its total and its
 * teams, a team node shows its total and its people. That is also the read split — the per-person
 * fan-out only happens for the team actually open.
 *
 * **Over-promising is shown, not blocked.** A pool may hand out more than it holds; the hub catches
 * the excess when the money is SPENT, along the whole chain, not when it is promised. So a total
 * that exceeds the pool is rendered as a plain warning line rather than a refused edit.
 */
import type { MemberBudget, ScopeBudget } from '@sdk';
import { Loader2, UserPlus, Wallet } from 'lucide-react';
import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

import { formatUsd } from '@src/components/llm-endpoints/usage-math';
import { useSetupScope } from '@src/components/token-plan/use-token-plan';
import { Button } from '@src/components/ui/button';
import { ConfirmDialog } from '@src/components/ui/confirm-dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@src/components/ui/table';
import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';

import { AddPeopleDialog } from './AddPeopleDialog';
import { MoneyBox } from './MoneyBox';
import { useOrgBudgets, useRemoveAllowance, useSetLifetimeCap, useTeamBudgets } from './use-budgets';

export interface BudgetSectionProps {
  /** `organization` or `team` — the node selected in the tree. */
  nodeType: string;
  nodeId: string;
  nodeLabel: string;
}

export function BudgetSection({ nodeType, nodeId, nodeLabel }: BudgetSectionProps) {
  return nodeType === 'organization' ? (
    <OrgBudgets orgId={nodeId} orgLabel={nodeLabel} />
  ) : (
    <TeamBudgetsPanel teamId={nodeId} teamLabel={nodeLabel} />
  );
}

// ── organization ──────────────────────────────────────────────────────────────

function OrgBudgets({ orgId, orgLabel }: { orgId: string; orgLabel: string }) {
  const { t } = useLingui();
  const { data, isLoading, error } = useOrgBudgets(orgId);
  const setCap = useSetLifetimeCap();

  if (error) return <Denied />;
  if (isLoading || !data) return <Loading />;

  return (
    <section className="flex flex-col gap-3" data-testid="org-budget-section">
      <Header
        scope={data.org}
        label={orgLabel}
        allocatedNoun={t`to teams`}
        kind="org"
        scopeId={orgId}
        onSetCap={(usd) => setCap.mutate({ endpointId: data.org.endpoint_id as string, usd })}
      />
      {data.org.endpoint_id && (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>
                  <Trans>Team</Trans>
                </TableHead>
                <TableHead className="text-end">
                  <Trans>Budget</Trans>
                </TableHead>
                <TableHead className="text-end">
                  <Trans>Spent</Trans>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.teams.length === 0 && (
                <TableRow>
                  <TableCell colSpan={3} className="py-6 text-center text-sm text-muted-foreground">
                    <Trans>No teams yet.</Trans>
                  </TableCell>
                </TableRow>
              )}
              {data.teams.map((team) => (
                <TableRow key={team.id} data-testid={`org-budget-team-${team.id}`}>
                  <TableCell>{team.name}</TableCell>
                  <TableCell className="text-end">
                    {team.endpoint_id ? (
                      <MoneyBox
                        value={team.limit_usd}
                        ariaLabel={t`Budget for ${team.name}`}
                        data-testid={`team-cap-${team.id}`}
                        disabled={setCap.isPending}
                        onCommit={(usd) => setCap.mutate({ endpointId: team.endpoint_id as string, usd })}
                      />
                    ) : (
                      <SetUpButton kind="team" scopeId={team.id} label={team.name} />
                    )}
                  </TableCell>
                  <TableCell className="text-end tabular-nums">{formatUsd(team.spent_usd)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}

// ── team ──────────────────────────────────────────────────────────────────────

function TeamBudgetsPanel({ teamId, teamLabel }: { teamId: string; teamLabel: string }) {
  const { t } = useLingui();
  const { data, isLoading, error } = useTeamBudgets(teamId);
  const setCap = useSetLifetimeCap();
  const remove = useRemoveAllowance();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<MemberBudget | null>(null);

  if (error) return <Denied />;
  if (isLoading || !data) return <Loading />;

  const poolId = data.team.endpoint_id;

  return (
    <section className="flex flex-col gap-3" data-testid="team-budget-section">
      <Header
        scope={data.team}
        label={teamLabel}
        allocatedNoun={t`to people`}
        kind="team"
        scopeId={teamId}
        onSetCap={(usd) => setCap.mutate({ endpointId: poolId as string, usd })}
        action={
          poolId ? (
            <Button size="sm" data-testid="budget-add-people" onClick={() => setAdding(true)}>
              <UserPlus className="h-4 w-4" />
              <Trans>Add people</Trans>
            </Button>
          ) : null
        }
      />

      {poolId && (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>
                  <Trans>Name</Trans>
                </TableHead>
                <TableHead>
                  <Trans>Email</Trans>
                </TableHead>
                <TableHead className="text-end">
                  <Trans>Budget</Trans>
                </TableHead>
                <TableHead className="text-end">
                  <Trans>Spent</Trans>
                </TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.members.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-6 text-center text-sm text-muted-foreground">
                    <Trans>Nobody has a budget in this team yet.</Trans>
                  </TableCell>
                </TableRow>
              )}
              {data.members.map((member) => (
                <TableRow key={member.endpoint_id} data-testid={`member-budget-${member.endpoint_id}`}>
                  <TableCell>{member.name}</TableCell>
                  <TableCell className="text-muted-foreground">{member.email ?? '—'}</TableCell>
                  <TableCell className="text-end">
                    <MoneyBox
                      value={member.limit_usd}
                      ariaLabel={t`Budget for ${member.name}`}
                      data-testid={`member-cap-${member.endpoint_id}`}
                      disabled={setCap.isPending}
                      onCommit={(usd) => setCap.mutate({ endpointId: member.endpoint_id, usd })}
                    />
                  </TableCell>
                  <TableCell className="text-end tabular-nums">{formatUsd(member.spent_usd)}</TableCell>
                  <TableCell className="text-end">
                    {/* The hub mints its own per-user default again on that person's next read, so
                        removing one achieves nothing but a confusing reappearance. */}
                    {!member.system_default && (
                      <Button
                        size="sm"
                        variant="ghost"
                        data-testid={`member-remove-${member.endpoint_id}`}
                        onClick={() => setRemoving(member)}
                      >
                        <Trans>Remove</Trans>
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {poolId && adding && (
        <AddPeopleDialog open onOpenChange={setAdding} poolId={poolId} teamName={teamLabel} existing={data.members} />
      )}

      <ConfirmDialog
        open={!!removing}
        onOpenChange={(next) => !next && setRemoving(null)}
        variant="destructive"
        title={t`Remove this budget?`}
        description={t`${removing?.name ?? ''} will no longer be able to spend from ${teamLabel}. Money already spent is not affected.`}
        confirmLabel={t`Remove`}
        onConfirm={() => {
          if (!removing) return;
          const target = removing;
          setRemoving(null);
          remove.mutate(
            { endpointId: target.endpoint_id },
            {
              onError: (e) =>
                notify.error({
                  title: t`Could not remove ${target.name}`,
                  message: errorMessage(e, ''),
                  id: 'budget-remove',
                }),
            },
          );
        }}
      />
    </section>
  );
}

// ── shared pieces ─────────────────────────────────────────────────────────────

function Header({
  scope,
  label,
  allocatedNoun,
  kind,
  scopeId,
  onSetCap,
  action,
}: {
  scope: ScopeBudget;
  label: string;
  allocatedNoun: string;
  kind: 'org' | 'team';
  scopeId: string;
  onSetCap: (usd: number | null) => void;
  action?: React.ReactNode;
}) {
  const { t } = useLingui();
  const over = scope.limit_usd !== null && scope.allocated_usd !== null && scope.allocated_usd > scope.limit_usd;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <Wallet className="h-4 w-4" />
          <Trans>Budget</Trans>
        </div>
        {action}
      </div>

      {scope.endpoint_id ? (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-md border border-border px-3 py-2 text-sm">
          <label className="flex items-center gap-2">
            <span className="text-muted-foreground">
              <Trans>Total</Trans>
            </span>
            <MoneyBox
              value={scope.limit_usd}
              ariaLabel={t`Total budget for ${label}`}
              data-testid={`${kind}-total-cap`}
              onCommit={onSetCap}
            />
          </label>
          <span className="text-muted-foreground">
            <Trans>Spent</Trans>{' '}
            <span className="font-medium tabular-nums text-foreground">{formatUsd(scope.spent_usd)}</span>
          </span>
          {scope.allocated_usd !== null && (
            <span className="text-muted-foreground" data-testid={`${kind}-allocated`}>
              <Trans>Given out {allocatedNoun}</Trans>{' '}
              <span className={`font-medium tabular-nums ${over ? 'text-destructive' : 'text-foreground'}`}>
                {formatUsd(scope.allocated_usd)}
              </span>
            </span>
          )}
        </div>
      ) : (
        <div className="flex items-center justify-between gap-3 rounded-md border border-dashed border-border px-3 py-3 text-sm">
          <span className="text-muted-foreground">
            {kind === 'org' ? (
              <Trans>This organization has no budget yet.</Trans>
            ) : (
              <Trans>This team has no budget yet.</Trans>
            )}
          </span>
          <SetUpButton kind={kind === 'org' ? 'org' : 'team'} scopeId={scopeId} label={label} />
        </div>
      )}

      {over && (
        <p className="text-xs text-destructive" data-testid={`${kind}-over-allocated`}>
          <Trans>
            More has been given out than this budget holds. Nothing is blocked — whoever spends last will be refused
            once the money runs out.
          </Trans>
        </p>
      )}
    </div>
  );
}

function SetUpButton({ kind, scopeId, label }: { kind: 'org' | 'team'; scopeId: string; label: string }) {
  const { t } = useLingui();
  const setup = useSetupScope();

  return (
    <Button
      size="sm"
      variant="outline"
      disabled={setup.isPending}
      data-testid={`budget-setup-${kind}-${scopeId}`}
      onClick={() =>
        // `setupOrg` targets the caller's PRIMARY organization — the hub takes no org id — so for
        // someone who belongs to more than one, the row simply stays un-set-up rather than claiming
        // a budget it did not get.
        setup.mutate(
          { kind, id: scopeId },
          {
            onSuccess: () => notify.success({ title: t`Budget created for ${label}`, id: 'budget-setup' }),
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
  );
}

function Loading() {
  return (
    <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />
      <Trans>Loading budgets…</Trans>
    </div>
  );
}

/** The hub refuses the read outright below admin, so there is nothing to show and nothing to retry. */
function Denied() {
  return (
    <div className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
      <Trans>Only an admin of this organization can see its budgets.</Trans>
    </div>
  );
}
