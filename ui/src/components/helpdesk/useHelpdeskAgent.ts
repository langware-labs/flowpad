import { useMemo } from 'react';
import { QueryFilter, QueryRequest, SubAgent } from '@sdk';
import { useEntitiesQuery } from '@sdk/react/hooks';

/**
 * The support agent a portal repo ships, if it ships one.
 *
 * A cloned repo's `.claude/agents/*.md` is walked into a `SubAgent` scoped to
 * that project by the indexer's `REAL_PROJECT_CWD` registration — so a desk
 * gets an agent by committing a markdown file, with no backend work and no
 * schema change.
 *
 * `SubAgent`, not `Agent`: per the glossary rule, `Agent` is reserved for the
 * hub-level launchable principal, and the `.claude/agents/*.md` prompt asset is
 * `SubAgent` (type value `subagent`). The DIRECTORY keeps the name `agents`
 * because Claude Code owns that path.
 *
 * Matched on NAME rather than a new `AgentKind`: that enum has only
 * HARNESS/VIBE, and adding a member is a wire change for something a
 * convention already answers.
 */
export const HELPDESK_AGENT_NAME = 'support';

export interface HelpdeskAgentState {
  agent: SubAgent | null;
  /**
   * False until the query has answered. **Callers must not render the chat
   * before this flips**: `onProcessCreated` fires once, at creation, and the
   * sub-agent spec is persisted into the process's `cli_config` — so a send that
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
        type: SubAgent.type,
        name: `helpdeskAgent:${projectId ?? 'none'}`,
        query: new QueryFilter({
          match: { name: HELPDESK_AGENT_NAME, project_id: projectId ?? '' },
        }),
      }),
    [projectId],
  );

  // No `= []` default: that is a fresh array whenever data is undefined, which
  // would re-run the memo for the whole loading window.
  const { data, isLoading } = useEntitiesQuery<SubAgent>(request, { enabled: !!projectId });

  // `isLoading` already seeds to `enabled`, so with no project it is false and
  // the state is settled-with-no-agent without a special case.
  return useMemo(() => ({ agent: data?.[0] ?? null, ready: !isLoading }), [data, isLoading]);
}
