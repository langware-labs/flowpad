import { Agent, type AgentPlace } from '@sdk';
import { isHubOnly } from '@sdk/utils/hub-runtime';
import { Trans, useLingui } from '@lingui/react/macro';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Cloud, Loader2 } from 'lucide-react';

import { Button } from '@src/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@src/components/ui/select';
import { useDockNavigation } from '@src/navigation/useDockNavigation';

import { AgentAddCloudMachine } from './AgentAddCloudMachine';
import { AgentPlaceCard } from './AgentPlaceCard';
import { usePlaceDisplay } from './use-place-display';

/** Dock option naming the selected environment; absent = the first one listed. */
export const PLACE_OPTION = 'place';

interface AgentPlacesColumnProps {
  agent: Agent;
  /** Default prompt for a new schedule. */
  autoLaunchPrompt?: string;
  /** Pending local changes, for the local environment's version pill. */
  pendingChanges?: number;
}

/**
 * "Runs on" — one environment at a time, picked from a select: Development · local
 * (always there, listed first, so the default) and every cloud machine. Deploy sits next to it.
 *
 * Each environment is a Deployment and owns its config overrides and its schedules;
 * the definition on the left is shared. The selection lives in the URL. On the hub
 * there is no local environment and no deploy.
 */
export function AgentPlacesColumn({ agent, autoLaunchPrompt, pendingChanges = 0 }: AgentPlacesColumnProps) {
  const { t } = useLingui();
  const { navigation, currentDock } = useDockNavigation();
  const display = usePlaceDisplay();
  const [places, setPlaces] = useState<AgentPlace[] | null>(null);
  const [deployOpen, setDeployOpen] = useState(false);
  const hub = isHubOnly();

  const agentRef = useRef(agent);
  agentRef.current = agent;

  const load = useCallback(async () => {
    try {
      setPlaces(await agentRef.current.listPlaces());
    } catch {
      setPlaces([]);
    }
  }, []);

  // Re-read when this agent's place settings change (an override, a switch) —
  // not on every save of the definition, which also rewrites agent.md.
  const placesKey = JSON.stringify([agent.id, agent.enabled ?? null, agent.places ?? null, agent.email_place ?? null]);
  useEffect(() => {
    void load();
  }, [load, placesKey]);

  // The server lists this computer first, so the first visible place is the default.
  const visible = (places ?? []).filter((place) => !hub || !place.is_local);
  const wanted = currentDock?.options?.[PLACE_OPTION];
  const selected = visible.find((place) => place.deployment.id === wanted) ?? visible[0];

  const select = (id: string) => {
    if (currentDock) navigation.openDock(currentDock.withOption(PLACE_OPTION, id));
  };
  const deployed = async (deploymentId?: string) => {
    await load();
    if (deploymentId) select(deploymentId);
  };

  return (
    <section className="flex flex-col gap-3" aria-labelledby="agent-runs-on" data-testid="agent-places">
      <div className="flex items-center gap-2">
        <h2 id="agent-runs-on" className="shrink-0 text-sm font-semibold">
          <Trans>Runs on</Trans>
        </h2>
        {places === null ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : selected ? (
          <Select value={selected.deployment.id} onValueChange={select}>
            <SelectTrigger className="h-8 min-w-0 flex-1" aria-label={t`Environment`} data-testid="agent-place-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {visible.map((place) => {
                const { label, Icon } = display(place);
                return (
                  <SelectItem
                    key={place.deployment.id}
                    value={place.deployment.id}
                    data-testid={`agent-place-option-${place.deployment.id}`}
                  >
                    <span className="flex items-center gap-2">
                      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      {label}
                    </span>
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        ) : (
          // Only on the hub, which lists no local environment.
          <span className="flex-1 text-xs text-muted-foreground">
            <Trans>No cloud machine yet.</Trans>
          </span>
        )}
        {!hub && (
          <Button
            size="sm"
            variant={deployOpen ? 'secondary' : 'outline'}
            className="h-8 shrink-0"
            onClick={() => setDeployOpen((open) => !open)}
            data-testid="agent-add-cloud-machine"
          >
            <Cloud className="me-1.5 h-3.5 w-3.5" />
            <Trans>Deploy</Trans>
          </Button>
        )}
      </div>
      {deployOpen && !hub && (
        <AgentAddCloudMachine agent={agent} onClose={() => setDeployOpen(false)} onDeployed={deployed} />
      )}
      {selected && (
        <AgentPlaceCard
          key={selected.deployment.id}
          agent={agent}
          place={selected}
          autoLaunchPrompt={autoLaunchPrompt}
          pendingChanges={pendingChanges}
          onChanged={load}
        />
      )}
    </section>
  );
}
