import { Agent } from '@sdk';
import { useEntitiesQuery } from '@sdk/react/hooks';
import { QueryRequest } from '@sdk';

const agentQuery = new QueryRequest({
  type: Agent.type,
  scope: [],
  name: 'useAgents:all',
});

/** All Agent definition entities (harness .claude/agents/*.md) from the SDK cache. */
export function useAgents() {
  const { data: agents = [], isLoading } = useEntitiesQuery<Agent>(agentQuery);
  return { agents, isLoading };
}
