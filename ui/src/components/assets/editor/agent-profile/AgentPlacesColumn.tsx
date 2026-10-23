import { Agent, type AgentPlace } from '@sdk';
import { isHubOnly } from '@sdk/utils/hub-runtime';
import { Trans, useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { ChevronRight, Loader2, Plus, Server } from 'lucide-react';

import { Button } from '@src/components/ui/button';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { formatTimeAgo } from '@src/utils/format-time-ago';

import { providerIcon, useAgentChannels } from '@src/components/agent-resources/AgentWebhooksSection';
import { NewDeploymentDialog } from './NewDeploymentDialog';
import { useAgentPlaces } from './use-agent-places';
import { usePlaceDisplay } from './use-place-display';

interface AgentPlacesColumnProps {
  agent: Agent;
  /** Saves the size a new cloud machine is created at (`machine_size` in agent.json); resolves once written. */
  onMachineSize?: (size: string) => Promise<unknown>;
}

/**
 * The agent's deployments — this computer (always there, listed first) and every cloud machine —
 * as one plain list under a single "New deployment" button. Channels, schedules and the other
 * resources live in the menu on the left; a row opens the deployment's own page, nested in the
 * agent (its live timeline and processes), and says when it was last active. On the hub there is no local deployment and
 * no deploy.
 */
export function AgentPlacesColumn({ agent, onMachineSize }: AgentPlacesColumnProps) {
  const { t } = useLingui();
  const { navigation, currentDock } = useDockNavigation();
  const display = usePlaceDisplay();
  const { places, reload } = useAgentPlaces(agent);
  // The hub has no `places` call; it answers where the agent runs and what is wired to it in one read.
  const wired = useAgentChannels(agent);
  const [deployOpen, setDeployOpen] = useState(false);
  const hub = isHubOnly();

  // The server lists this computer first.
  const visible = (places ?? []).filter((place) => !hub || !place.is_local);
  // A deployment's page opens nested in the agent — project › agent › Deployments › it — in this tab.
  const openPage = (place: AgentPlace) =>
    currentDock && navigation.openDock(currentDock.withChild('deployment', `deployment-${place.deployment.id}`));

  return (
    <section className="flex flex-col gap-3" aria-labelledby="agent-deployments" data-testid="agent-places">
      <div className="flex items-center justify-between gap-2">
        <h2 id="agent-deployments" className="text-sm font-semibold">
          <Trans>Deployments</Trans>
        </h2>
        {!hub && (
          <Button
            size="sm"
            variant="outline"
            className="h-8 shrink-0"
            onClick={() => setDeployOpen(true)}
            data-testid="agent-new-deployment"
          >
            <Plus className="me-1.5 h-3.5 w-3.5" />
            <Trans>New deployment</Trans>
          </Button>
        )}
      </div>
      {deployOpen && !hub && (
        <NewDeploymentDialog
          agent={agent}
          open
          onOpenChange={setDeployOpen}
          onMachineSize={onMachineSize}
          onLaunched={reload}
        />
      )}
      {places === null ? (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      ) : visible.length === 0 && hub && wired && wired.deployments.length > 0 ? (
        <ul className="flex flex-col divide-y rounded-md border" data-testid="agent-hub-deployments">
          {wired.deployments.map((d) => (
            <li key={d.typeid} className="flex items-center gap-2 px-3 py-2 text-sm">
              <Server className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{d.node_typeid ? t`Cloud machine` : t`No machine yet`}</span>
            </li>
          ))}
        </ul>
      ) : visible.length === 0 ? (
        <span className="text-xs text-muted-foreground" data-testid="agent-places-empty">
          <Trans>Not deployed yet — it runs nowhere until you launch it.</Trans>
        </span>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border" data-testid="agent-places-list">
          {visible.map((place) => {
            const { label, Icon } = display(place);
            return (
              <li key={place.deployment.id}>
                <button
                  type="button"
                  onClick={() => openPage(place)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-start hover:bg-muted/60"
                  data-testid={`agent-place-row-${place.deployment.id}`}
                >
                  <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-sm">{label}</span>
                  <span
                    className="shrink-0 text-xs text-muted-foreground"
                    data-testid={`agent-place-state-${place.deployment.id}`}
                  >
                    {stateOf(place)}
                  </span>
                  <span
                    className="w-20 shrink-0 text-end text-xs text-muted-foreground"
                    title={place.last_active ? new Date(place.last_active).toLocaleString() : undefined}
                    data-testid={`agent-place-last-active-${place.deployment.id}`}
                  >
                    {formatTimeAgo(place.last_active) ?? t`never`}
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground rtl:-scale-x-100" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {wired && (wired.webhooks.length > 0 || wired.connections.length > 0) && (
        <div className="flex flex-col gap-1.5" data-testid="agent-wiring">
          <h3 className="text-xs font-semibold text-muted-foreground">
            <Trans>Webhooks & connections</Trans>
          </h3>
          <ul className="flex flex-col divide-y rounded-md border">
            {wired.webhooks.map((hook) => {
              const Icon = providerIcon(hook.provider);
              return (
                <li
                  key={hook.id}
                  className="flex items-center gap-2 px-3 py-2 text-sm"
                  data-testid={`agent-webhook-${hook.id}`}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">
                    {hook.sender ? `${hook.provider} · ${hook.sender}` : hook.provider}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {hook.status === 'active'
                      ? t`Linked`
                      : hook.status === 'pending'
                        ? t`Waiting for the link`
                        : t`Lapsed`}
                  </span>
                </li>
              );
            })}
            {[...new Set(wired.connections.map((c) => c.provider))].map((provider) => {
              const Icon = providerIcon(provider);
              return (
                <li
                  key={`c-${provider}`}
                  className="flex items-center gap-2 px-3 py-2 text-sm"
                  data-testid={`agent-connection-${provider}`}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{t`${provider} connection`}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{t`Its machine may use it`}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );

  function stateOf(place: AgentPlace): string {
    if (!place.enabled) return t`Off`;
    // The wire row, not `new Deployment(...)`: constructing an entity registers it in the shared cache,
    // and doing that in render re-rendered this column forever (the app froze opening the agent).
    const status = place.deployment.status as { provider_state?: string } | undefined;
    if (status?.provider_state === 'paused') return t`Paused`;
    if (place.behind) return t`Update available`;
    return place.is_local ? t`On` : t`Running`;
  }
}
