import { useEffect, useState } from 'react';
import { Agent, agentParticipant as agentAsParticipant, dataManager, hubAction, type ConversationParticipant } from '@sdk';

/** An agent the person can add to a conversation. */
export interface AgentSuggestion {
  /** The agent's id. */
  id: string;
  name: string;
}

/** An agent as the hub lists it with the caller's permissions (`expand=permissions`). */
export interface HubAgentRow {
  id?: string | null;
  name?: string | null;
  expand?: { roles?: string[] | null; allowed_actions?: string[] | null } | null;
}

/**
 * The agents to offer: the hub agents on which the caller holds a role. The hub decides the rest when the
 * agent is added (`Agent.handle_conversation_invite`): which of its deployments answers, and whether the
 * caller may use one -- a refusal comes back as the answer. A row read without its permissions is never offered.
 */
export function invitableAgents(agents: HubAgentRow[]): AgentSuggestion[] {
  return agents
    .filter((a): a is HubAgentRow & { id: string } => !!a.id && (a.expand?.roles?.length ?? 0) > 0)
    .map((a) => ({ id: a.id, name: (a.name ?? '').trim() || a.id }));
}

/** Filter agents by a name query (case-insensitive). Empty → all. */
export function filterAgents(agents: AgentSuggestion[], query: string): AgentSuggestion[] {
  const q = query.trim().toLowerCase();
  if (!q) return agents;
  return agents.filter((a) => a.name.toLowerCase().includes(q));
}

/** A picked agent as a participant: ONE entry keyed `agent-<id>`. */
export function agentParticipant(agent: AgentSuggestion): ConversationParticipant {
  return agentAsParticipant(agent.id, agent.name);
}

/** The caller's agents on the hub, each with the caller's permissions on it. */
async function hubAgents(): Promise<HubAgentRow[]> {
  const action = hubAction('', Agent.type, null, 'GET');
  action.queryParameters = { expand: 'permissions' };
  const rows = await dataManager.callAction<undefined, HubAgentRow[]>(action);
  return Array.isArray(rows) ? rows : [];
}

/**
 * The agents the person can pick (`invitableAgents`), read from the hub. Nothing is read while `enabled`
 * is false; signed out, the list is empty.
 */
export function useAgentSuggestions(enabled: boolean): { agents: AgentSuggestion[] } {
  const [agents, setAgents] = useState<AgentSuggestion[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    void hubAgents()
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
