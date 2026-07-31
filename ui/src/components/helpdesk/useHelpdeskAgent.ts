import { useMemo } from 'react';
import { Agent, QueryFilter, QueryRequest } from '@sdk';
import { useEntitiesQuery } from '@sdk/react/hooks';

/**
 * The support agent a portal repo ships, if it ships one.
 *
 * A cloned repo's `.claude/agents/*.md` is walked into `Agent` entities scoped
 * to that project by the indexer's `REAL_PROJECT_CWD` registration — so a desk
 * gets an agent by committing a markdown file, with no backend work and no
 * schema change. We match on NAME rather than a new `AgentKind`, because
 * `AgentKind` only has HARNESS/VIBE today and adding a member is a wire change
 * for something a convention already answers.
 */
export const HELPDESK_AGENT_NAME = 'support';

export interface HelpdeskAgentState {
  agent: Agent | null;
  /**
   * False until the query has answered. **Callers must not render the chat
   * before this flips**: `onProcessCreated` fires once, at creation, and the
   * agent spec is persisted into the process's `cli_config` — so a send that
   * beats the query births a session that is permanently persona-less.
   */
  ready: boolean;
}

export function useHelpdeskAgent(projectId?: string | null): HelpdeskAgentState {
  // Matched on the `project_id` FIELD, not graph `scope`. An indexed agent is
  // stamped with its project id but is not attached to the project as a graph
  // child, so a scope-filtered query returns zero rows — verified here: the
  // agent is reachable by REST with the right `project_id` while the scoped
  // query found nothing. Both keys are server-side matches, so this is a
  // filtered query, not an unscoped get-all.
  const request = useMemo(
    () =>
      new QueryRequest({
        type: Agent.type,
        name: `helpdeskAgent:${projectId ?? 'none'}`,
        query: new QueryFilter({
          match: { name: HELPDESK_AGENT_NAME, project_id: projectId ?? '' },
        }),
      }),
    [projectId],
  );

  const { data: agents = [], isLoading } = useEntitiesQuery<Agent>(request, {
    enabled: !!projectId,
  });

  return useMemo(
    () => ({
      agent: agents[0] ?? null,
      // No project means nothing to wait for — settled, with no agent.
      ready: !projectId ? true : !isLoading,
    }),
    [agents, isLoading, projectId],
  );
}
