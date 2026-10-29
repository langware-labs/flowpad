/**
 * What pays for a deployment's turns — the hub's own answer (`deployment/<id>/funding`): its allocation
 * (a sub-endpoint of a budget), a shared budget or its owner's default, the size it runs and the model
 * that size is, and why the next turn would be refused. A refusal is never a silent empty state: the
 * card turns red and the user is notified once.
 */
import type { Agent, AgentTokenAllocation, Deployment, DeploymentFunding } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { Button } from '@src/components/ui/button';
import { errorMessage } from '@src/lib/error-message';

import { openLlmEndpoint } from '@src/components/llm-endpoints/llm-endpoints-pointer';
import { cn } from '@src/lib/utils';
import { notify } from '@src/notifications';
import { useDockNavigation } from '@src/navigation/useDockNavigation';

import { TokenAllocationField, tokenAllocationComplete } from '../TokenAllocationField';

export function useDeploymentFunding(deployment: Deployment | null | undefined) {
  return useQuery({
    queryKey: ['deployment', deployment?.id, 'funding'],
    queryFn: () => (deployment as Deployment).funding(),
    enabled: !!deployment?.id,
    staleTime: 30_000,
  });
}

function sourceLabel(funding: DeploymentFunding, ownerDefault: string): string {
  if (funding.kind === 'default') return `${funding.name} (${ownerDefault})`;
  return funding.name || funding.endpoint_typeid;
}

/** One line for a list cell: who pays, and a red dot when it cannot. */
export function FundedBy({ deployment }: { deployment: Deployment }) {
  const { t } = useLingui();
  const { data } = useDeploymentFunding(deployment);
  if (!data) return <span className="text-muted-foreground">—</span>;
  return (
    <span
      className={cn('block truncate', data.exhausted ? 'text-destructive' : 'text-foreground')}
      title={data.exhausted || undefined}
      data-testid={`funded-by-${deployment.id}`}
    >
      {data.kind === 'none' ? t`No funding` : sourceLabel(data, t`owner default`)}
    </span>
  );
}

export function DeploymentFundingCard({ agent, deployment }: { agent: Agent; deployment: Deployment }) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const { data, error } = useDeploymentFunding(deployment);
  const told = useRef('');
  const problem = error ? String(error.message ?? error) : (data?.exhausted ?? '');

  useEffect(() => {
    if (problem && told.current !== problem) {
      told.current = problem;
      notify.error({ title: t`${deployment.name} cannot pay for its next turn`, message: problem });
    }
  }, [problem, deployment.name, t]);

  if (!data && !error) return null;
  return (
    <div
      className={cn(
        'my-3 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border px-4 py-2 text-sm',
        problem ? 'border-destructive/40 bg-destructive/10' : 'border-border',
      )}
      data-testid="deployment-funding"
    >
      <span className="font-medium">
        <Trans>Funding</Trans>
      </span>
      {data && data.kind !== 'none' && (
        <button
          type="button"
          className="underline-offset-2 hover:underline"
          onClick={() => data.endpoint_typeid && openLlmEndpoint(navigation, data.endpoint_typeid)}
          data-testid="deployment-funding-source"
        >
          {sourceLabel(data, t`owner default`)}
        </button>
      )}
      {data?.model && (
        <span className="font-mono text-xs text-muted-foreground" data-testid="deployment-funding-model">
          {data.size ? `${data.size} → ${data.model}` : data.model}
        </span>
      )}
      <ChangeAllocation agent={agent} deployment={deployment} />
      {problem && (
        <span className="w-full text-destructive" data-testid="deployment-funding-problem">
          {problem}
        </span>
      )}
    </div>
  );
}

/** Give the deployment its own sub-budget (or a new one): a source, a daily cap and a size or model. */
function ChangeAllocation({ agent, deployment }: { agent: Agent; deployment: Deployment }) {
  const { t } = useLingui();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState<AgentTokenAllocation | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await agent.planDeployment(deployment.environment, deployment.target.provider, value);
      notify.success({ title: value ? t`Allocation saved` : t`Back on the owner's default` });
      setEditing(false);
      await queryClient.invalidateQueries({ queryKey: ['deployment', deployment.id, 'funding'] });
    } catch (e) {
      notify.error({ title: t`Could not change the allocation`, message: errorMessage(e, '') });
    } finally {
      setBusy(false);
    }
  };

  if (!editing) {
    return (
      <Button
        variant="outline"
        size="sm"
        className="ms-auto h-7"
        onClick={() => setEditing(true)}
        data-testid="deployment-change-allocation"
      >
        <Trans>Change allocation</Trans>
      </Button>
    );
  }
  return (
    <div className="w-full space-y-2 pt-2" data-testid="deployment-allocation-editor">
      <TokenAllocationField
        agent={agent}
        environment={deployment.environment}
        provider={deployment.target.provider}
        value={value}
        onChange={setValue}
        disabled={busy}
      />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={busy}>
          <Trans>Cancel</Trans>
        </Button>
        <Button
          size="sm"
          onClick={() => void save()}
          disabled={busy || (value !== null && !tokenAllocationComplete(value))}
          data-testid="deployment-allocation-save"
        >
          {busy ? '…' : t`Save`}
        </Button>
      </div>
    </div>
  );
}
