import { SubAgent } from '@sdk';
import { useEntitiesQuery } from '@sdk/react/hooks';
import { QueryRequest } from '@sdk';

const agentQuery = new QueryRequest({
  type: SubAgent.type,
  scope: [],
  name: 'useAgents:all',
});

/** All SubAgent definition entities (harness .claude/agents/*.md) from the SDK cache. */
export function useAgents() {
  const { data: agents = [], isLoading } = useEntitiesQuery<SubAgent>(agentQuery);
  return { agents, isLoading };
}
