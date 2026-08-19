import { Agent, Deployment, QueryRequest } from '@sdk';
import { useEntitiesQuery } from '@sdk/react/hooks';
import { Trans, useLingui } from '@lingui/react/macro';
import { useCallback, useMemo, useState } from 'react';
import { Cloud, ExternalLink, Loader2, MessageSquare, PauseCircle, Trash2 } from 'lucide-react';

import { notify } from '@src/notifications';
import { Button } from '@src/components/ui/button';
import { showDeleteAssetModal } from '@src/components/assets/delete-asset-modal';
import { isHubOnly } from '@src/navigation/hub-runtime';

import { DeployedAgentChatPanel } from './DeployedAgentChatPanel';

interface AgentDeploymentsSectionProps {
  agent: Agent;
}

const STATUS_COLOR: Record<string, string> = {
  current: 'bg-green-500',
  stale: 'bg-amber-400',
  partial: 'bg-orange-500',
  error: 'bg-red-500',
};

/**
 * Every machine this agent is placed on.
 *
 * A list of real `Deployment` rows, not the response of the last click. This
 * used to hold the deploy result in `useState` and forget it on reload, because
 * the hub had no row to hold — it stamped a single `node_typeid` pointer, so a
 * second deploy overwrote the first and leaked the box. Now the hub creates a
 * Deployment, the local backend adopts it at the SAME id, and the ordinary
 * entity query below is the whole story.
 *
 * Deploying twice is therefore safe: the backend converges on the existing
 * placement rather than booting another sandbox.
 */
export function AgentDeploymentsSection({ agent }: AgentDeploymentsSectionProps) {
  const { t } = useLingui();
  const [deploying, setDeploying] = useState(false);
  const [pausing, setPausing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [chatDeploymentId, setChatDeploymentId] = useState<string | null>(null);
  const hubMode = isHubOnly();

  const request = useMemo(
    () =>
      new QueryRequest({
        type: Deployment.type,
        scope: [],
        // `query`, NOT `match` — QueryRequest has no `match` key, so passing one
        // is silently dropped and the list becomes every deployment on the
        // machine. `QueryFilter.parse` wraps this bare dict into `match` itself.
        query: { parent_type_id: agent.typeId.toString() },
        name: 'agentDeployments',
      }),
    [agent.typeId],
  );
  const { data: deployments = [], refetch } = useEntitiesQuery<Deployment>(request);

  const deploy = useCallback(async () => {
    setDeploying(true);
    try {
      const data = await agent.deploy();
      if (data.agent_definition_error) {
        // The machine is live but is not yet the agent — a genuinely partial
        // outcome, so say so rather than showing an unqualified success.
        notify.warning({
          title: t`Deployed without its definition`,
          message: data.agent_definition_error,
        });
      } else if (data.reused) {
        notify.info({ title: t`${agent.name} is already deployed` });
      } else {
        notify.success({ title: t`${agent.name} is deployed` });
      }
      await refetch();
    } catch (e) {
      notify.error({
        title: t`Could not deploy`,
        message: e instanceof Error ? e.message : t`Deploy failed.`,
        // The ONE case `forceToast` is documented for: this alert is the only
        // feedback that Deploy did anything. Alerts are otherwise toasted in Dev
        // mode only, so outside Dev the button reported nothing at all — the
        // agent has no owning project, or its project has no GitHub connection,
        // and the user sees a button that silently does nothing.
        forceToast: true,
      });
    } finally {
      setDeploying(false);
    }
  }, [agent, refetch, t]);

  const pause = useCallback(
    async (deployment: Deployment) => {
      setPausing(deployment.id);
      try {
        await deployment.pause();
        await refetch();
      } catch (e) {
        notify.error({
          title: t`Could not pause`,
          message: e instanceof Error ? e.message : t`Pause failed.`,
        });
      } finally {
        setPausing(null);
      }
    },
    [refetch, t],
  );

  const remove = useCallback(
    (deployment: Deployment) => {
      showDeleteAssetModal({
        name: deployment.name,
        description:
          'This permanently destroys the deployment machine and removes its placement record. This cannot be undone.',
        onConfirm: async () => {
          setDeleting(deployment.id);
          try {
            await deployment.delete();
            setChatDeploymentId((current) => (current === deployment.id ? null : current));
            await refetch();
            notify.success({ title: t`Deployment deleted`, message: deployment.name });
          } finally {
            setDeleting(null);
          }
        },
      });
    },
    [refetch, t],
  );

  return (
    <section>
      <p className="mb-3 text-xs text-muted-foreground">
        <Trans>Publish this agent to the cloud and give it a machine that logs in as itself.</Trans>
      </p>
      <div className="flex flex-col gap-2">
        {deployments.map((deployment) => {
          const url = deployment.origin?.url || deployment.target.location;
          const chatOpen = chatDeploymentId === deployment.id;
          return (
            <div key={deployment.id} className="overflow-hidden rounded-md border text-sm">
              <div className="flex items-center gap-2 p-2">
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${
                    STATUS_COLOR[deployment.status.sync_state] ?? 'bg-muted-foreground'
                  }`}
                />
                <span className="min-w-0 flex-1 truncate">{deployment.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {deployment.status.provider_state ?? deployment.target.provider}
                </span>
                {hubMode && (
                  <Button
                    size="sm"
                    variant={chatOpen ? 'secondary' : 'ghost'}
                    onClick={() => setChatDeploymentId(chatOpen ? null : deployment.id)}
                    title={t`Chat with this deployed agent`}
                    aria-expanded={chatOpen}
                    data-testid={`deployment-chat-${deployment.id}`}
                  >
                    <MessageSquare className="h-3.5 w-3.5" />
                  </Button>
                )}
                {url && (
                  <Button size="sm" variant="ghost" asChild>
                    <a href={url} target="_blank" rel="noreferrer">
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  </Button>
                )}
                {deployment.target.provider !== 'local' && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pausing === deployment.id}
                    onClick={() => void pause(deployment)}
                    title={t`Pause this machine`}
                  >
                    {pausing === deployment.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <PauseCircle className="h-3.5 w-3.5" />
                    )}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={deleting === deployment.id}
                  onClick={() => remove(deployment)}
                  title={t`Delete this deployment`}
                >
                  {deleting === deployment.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="h-3.5 w-3.5" />
                  )}
                </Button>
              </div>
              {chatOpen && <DeployedAgentChatPanel agent={agent} deployment={deployment} />}
            </div>
          );
        })}

        <div className="flex items-center gap-3">
          <Button size="sm" disabled={!agent.enabled || deploying} onClick={() => void deploy()}>
            {deploying ? (
              <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Cloud className="me-1.5 h-3.5 w-3.5" />
            )}
            <Trans>Deploy</Trans>
          </Button>
          {deploying && (
            <span className="text-xs text-muted-foreground">
              {/* Create + boot + health on a real sandbox — tens of seconds. */}
              <Trans>Starting a machine — this takes a minute.</Trans>
            </span>
          )}
        </div>
      </div>
    </section>
  );
}
