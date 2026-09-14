import { Agent, type AgentPlace } from '@sdk';
import { isHubOnly } from '@sdk/utils/hub-runtime';
import { Trans } from '@lingui/react/macro';
import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';

import { AgentAddCloudMachine } from './AgentAddCloudMachine';
import { AgentPlaceCard } from './AgentPlaceCard';

interface AgentPlacesColumnProps {
  agent: Agent;
  /** Default prompt for a new schedule. */
  autoLaunchPrompt?: string;
  /** Pending local changes, for this computer's version pill. */
  pendingChanges?: number;
}

/**
 * "Runs on" — every place this agent runs on, this computer first.
 *
 * Each place is a Deployment and owns its config overrides, its schedules and
 * (at most one of them) the email address; the definition on the left is shared.
 * On the hub there is no "this computer": only cloud places, and no deploy.
 */
export function AgentPlacesColumn({ agent, autoLaunchPrompt, pendingChanges = 0 }: AgentPlacesColumnProps) {
  const [places, setPlaces] = useState<AgentPlace[] | null>(null);
  const hub = isHubOnly();

  const load = useCallback(async () => {
    try {
      setPlaces(await agent.listPlaces());
    } catch {
      setPlaces([]);
    }
  }, [agent]);

  // Re-read when the agent row changes: an override or email move rewrites agent.md.
  useEffect(() => {
    void load();
  }, [load, agent.updated_date]);

  const visible = (places ?? []).filter((place) => !hub || !place.is_local);

  return (
    <section className="flex flex-col gap-3" aria-labelledby="agent-runs-on" data-testid="agent-places">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="agent-runs-on" className="text-sm font-semibold">
          <Trans>Runs on</Trans>
        </h2>
        <span className="text-xs text-muted-foreground">
          <Trans>Each place has its own config, schedules and email.</Trans>
        </span>
      </div>
      {places === null ? (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      ) : (
        visible.map((place) => (
          <AgentPlaceCard
            key={place.deployment.id}
            agent={agent}
            place={place}
            places={places}
            autoLaunchPrompt={autoLaunchPrompt}
            pendingChanges={pendingChanges}
            onChanged={load}
          />
        ))
      )}
      {!hub && <AgentAddCloudMachine agent={agent} onDeployed={load} />}
    </section>
  );
}
