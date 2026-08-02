import { Agent, AgentDeployResult } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { useCallback, useState } from 'react';
import { Cloud, ExternalLink, Loader2 } from 'lucide-react';

import { notify } from '@src/notifications';
import { Button } from '@src/components/ui/button';

import { AgentSection } from './AgentProfileFields';

interface AgentDeploymentsSectionProps {
  agent: Agent;
}

/**
 * Give the agent a machine of its own.
 *
 * One button, because the backend collapses what used to be two steps: it
 * publishes the agent to the hub and then asks the hub to boot a box that logs
 * in AS that agent. Nothing about the machine is chosen here — an agent must not
 * be deployable onto a caller-picked box (see `Agent.deploy_action` on the hub).
 *
 * **The result is not persisted yet.** The hub has no `Deployment` row (gap D6);
 * it stamps `node_typeid` on the Agent as a placeholder, which the local copy
 * never receives. So this section shows the box it just launched and forgets it
 * on reload. When the Deployment row lands, this becomes a list and the local
 * state below goes away — do not build a client-side cache to paper over it.
 */
export function AgentDeploymentsSection({ agent }: AgentDeploymentsSectionProps) {
  const { t } = useLingui();
  const [deploying, setDeploying] = useState(false);
  const [result, setResult] = useState<AgentDeployResult | null>(null);

  const deploy = useCallback(async () => {
    setDeploying(true);
    try {
      const data = await agent.deploy();
      setResult(data);
      if (data.agent_definition_error) {
        // The machine is live but is not yet the agent — a genuinely partial
        // outcome, so say so rather than showing an unqualified success.
        notify.warning({
          title: t`Deployed without its definition`,
          message: data.agent_definition_error,
        });
      } else {
        notify.success({ title: t`${agent.name} is deployed` });
      }
    } catch (e) {
      notify.error({
        title: t`Could not deploy`,
        message: e instanceof Error ? e.message : t`Deploy failed.`,
      });
    } finally {
      setDeploying(false);
    }
  }, [agent, t]);

  return (
    <AgentSection
      title={t`Deployment`}
      hint={t`Publish this agent to the cloud and give it a machine that logs in as itself.`}
    >
      <div className="flex items-center gap-3">
        <Button size="sm" disabled={!agent.enabled || deploying} onClick={() => void deploy()}>
          {deploying ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Cloud className="mr-1.5 h-3.5 w-3.5" />
          )}
          <Trans>Deploy</Trans>
        </Button>
        {deploying && (
          <span className="text-xs text-muted-foreground">
            {/* Create + boot + health on a real sandbox — tens of seconds. */}
            <Trans>Starting a machine — this takes a minute.</Trans>
          </span>
        )}
        {!deploying && result?.host_url && (
          <Button size="sm" variant="outline" asChild>
            <a href={result.host_url} target="_blank" rel="noreferrer">
              <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
              <Trans>Open</Trans>
            </a>
          </Button>
        )}
      </div>
    </AgentSection>
  );
}
