import { useEffect, useState } from 'react';
import { dataManager, Deployment, deploymentParticipant, hubAction, type ConversationParticipant } from '@sdk';
import { canDo } from '@src/components/items/role';

/** An agent's deployment the person can add to a conversation. */
export interface AgentSuggestion {
  /** The deployment's id. */
  id: string;
  name: string;
}

/** A deployment as the hub lists it with the caller's permissions (`expand=permissions`). */
export interface HubDeploymentRow {
  id?: string | null;
  name?: string | null;
  identity?: string | null;
  target?: { provider?: string | null } | null;
  expand?: { roles?: string[] | null; allowed_actions?: string[] | null } | null;
}

/** The hub's name for adding a deployment's agent to a conversation (its policies.json). */
export const ADD_TO_CONVERSATION = 'use';

/** Who a machine must sign in as for its agent to hold a role in a conversation. */
const AGENT_IDENTITIES = new Set(['agent', 'deployment']);

/**
 * The agents to offer: the hub deployments whose machine signs in as an agent and on which the hub
 * allows the caller `use` -- an action name in the hub's policies.json, so who may
 * add an agent is decided there, never by a role named here. This computer's own placement has no
 * hub Identity and is never offered; neither is a row read without its permissions.
 */
export function invitableAgents(deployments: HubDeploymentRow[]): AgentSuggestion[] {
  return deployments
    .filter(
      (d): d is HubDeploymentRow & { id: string } =>
        !!d.id &&
        d.target?.provider !== 'local' &&
        AGENT_IDENTITIES.has(d.identity ?? '') &&
        canDo({ expand: d.expand, getType: () => Deployment.type }, ADD_TO_CONVERSATION) === true,
    )
    .map((d) => ({ id: d.id, name: (d.name ?? '').trim() || d.id }));
}

/** Filter agents by a name query (case-insensitive). Empty → all. */
export function filterAgents(agents: AgentSuggestion[], query: string): AgentSuggestion[] {
  const q = query.trim().toLowerCase();
  if (!q) return agents;
  return agents.filter((a) => a.name.toLowerCase().includes(q));
}

/** A picked agent as a participant: ONE entry keyed `deployment-<id>`. */
export function agentParticipant(agent: AgentSuggestion): ConversationParticipant {
  return deploymentParticipant(agent.id, agent.name);
}

/** The caller's deployments on the hub, each with the caller's permissions on it. */
async function hubDeployments(): Promise<HubDeploymentRow[]> {
  const action = hubAction('', Deployment.type, null, 'GET');
  action.queryParameters = { expand: 'permissions' };
  const rows = await dataManager.callAction<undefined, HubDeploymentRow[]>(action);
  return Array.isArray(rows) ? rows : [];
}

/**
 * The agents the person can pick (`invitableAgents`), read from the hub: the desk holds only the
 * deployments it made itself. Nothing is read while `enabled` is false; signed out, the list is empty.
 */
export function useAgentSuggestions(enabled: boolean): { agents: AgentSuggestion[] } {
  const [agents, setAgents] = useState<AgentSuggestion[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    void hubDeployments()
      .catch(() => [])
      .then((rows) => {
        if (current) setAgents(invitableAgents(rows));
      });
    return () => {
      current = false;
    };
  }, [enabled]);
  return { agents: enabled ? agents : [] };
}
