import { useCallback, useEffect, useRef, useState } from 'react';
import { type Agent, type AgentPlace, dataContext } from '@sdk';
import { useOnTag } from '@sdk/react/hooks';

/** Every mounted reader of an agent's places, so one reload (a launch, a switch) refreshes them all. */
const readers = new Map<string, Set<() => void>>();

/**
 * The agent's deployments (`GET /agent/<id>/places`), for every view that shows them — the
 * Deployments list, the Schedules section, a deployment's page. Re-read when the agent's place
 * settings change, and whenever any of them calls `reload`.
 */
export function useAgentPlaces(agent: Agent | null | undefined): {
  places: AgentPlace[] | null;
  reload: () => Promise<void>;
} {
  const [places, setPlaces] = useState<AgentPlace[] | null>(null);
  const agentRef = useRef(agent);
  agentRef.current = agent;
  const agentId = agent?.id ?? null;

  const read = useCallback(async () => {
    const current = agentRef.current;
    if (!current) return;
    // Places are this backend's own deployments: a backend with no disk of its own (the hub) has none.
    if (!dataContext.caps.localFiles) return setPlaces([]);
    try {
      setPlaces(await current.listPlaces());
    } catch {
      setPlaces([]);
    }
  }, []);

  useEffect(() => {
    if (!agentId) return;
    const set = readers.get(agentId) ?? new Set();
    readers.set(agentId, set);
    const refresh = () => void read();
    set.add(refresh);
    return () => {
      set.delete(refresh);
      if (set.size === 0) readers.delete(agentId);
    };
  }, [agentId, read]);

  // Not on every save of the definition, which also rewrites agent.json — only its place settings.
  const placesKey = agent
    ? JSON.stringify([agent.id, agent.enabled ?? null, agent.places ?? null, agent.email_place ?? null])
    : null;
  useEffect(() => {
    void read();
  }, [read, placesKey]);
  // A place that just answered (a run starting or ending on this computer) should say so without a
  // reload: its `last_active` is read again on the same bus event the place's activity list follows.
  useOnTag('agent.status', () => {
    if (dataContext.caps.localFiles) void read();
  });
  // Listing answers with the local rows and asks the hub in the background (like the conversation
  // list); what the hub changed — a box made elsewhere, stopped, deleted — lands here.
  useOnTag('deployment.synced', (event) => {
    const parent = String((event.data as { parent_type_id?: string } | undefined)?.parent_type_id ?? '');
    if (agentId && parent.endsWith(agentId) && dataContext.caps.localFiles) void read();
  });

  const reload = useCallback(async () => {
    await read();
    for (const refresh of (agentId && readers.get(agentId)) || []) refresh();
  }, [agentId, read]);

  return { places, reload };
}
