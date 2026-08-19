import { Agent, QueryFilter, QueryRequest } from '@sdk';
import { useEntitiesQuery } from '@sdk/react/hooks';
import { useMemo } from 'react';

/** How many agents a home surface will show. The two vibe heroes center their
 *  column inside `overflow-hidden`, so an unbounded grid does not scroll — it
 *  is silently clipped. Bound it in the QUERY (not a `.slice()`) so the cap is
 *  one fact rather than a render-time trim. */
const MAX_HOME_AGENTS = 8;

/**
 * The project's launchable `Agent` assets (`agentic-assets/agent/<name>/agent.md`),
 * alphabetical — the set every home surface offers as one-click sessions.
 *
 * NOT `SubAgent` (`.claude/agents/*.md`): that is the provider-owned prompt asset
 * `useVibeAgents` lists, which has no avatar and nothing to launch. See
 * `use-vibe-agents.ts` for the sibling query.
 *
 * The request is memoized (the infinite-loop rule). It also has to be identical
 * across mounts: `VibeSwap` keeps BOTH home branches mounted (`display:none`,
 * not a conditional), so the strip mounts twice at once on `/`. Matching
 * `type`/`query`/`scope` is what makes those two share one fetch and one
 * subscription — `QueryRequest.key` is built from those three, and `name` is
 * NOT part of it, so the name is a label for debugging, not the dedup key.
 */
export function useProjectAgents(projectId?: string | null) {
  const request = useMemo(
    () =>
      new QueryRequest({
        type: Agent.type,
        scope: [],
        name: `projectAgents:${projectId ?? 'none'}`,
        // Membership by `project_id` match, NOT by carrying the project as a
        // `scope` — the same choice `use-project-tasks.ts` and
        // `useHelpdeskAgent.ts` already make, for a reason worth stating once:
        // a project scope resolves through a recursive CTE over `is_child`
        // relationship edges, and only the CREATE path writes such an edge
        // (`graph_crud_actions` → `add_child`). The indexer, discovering an
        // agent on disk under the project's `agentic-assets/agent/`, stamps
        // `project_id` and no edge — so a scoped query silently omits it and a
        // project's own agents go missing from its home. `project_id` is the
        // field that actually means "belongs to this project".
        //
        // `order_by`/`limit` belong INSIDE QueryFilter: `QueryFilter.parse`
        // wraps a bare dict wholesale into `match`, so a top-level key would
        // silently become a field predicate matching nothing. Alphabetical, not
        // created-date — a launcher that reshuffles as agents are added is
        // disorienting.
        query: new QueryFilter({
          match: { project_id: projectId },
          order_by: { name: 'asc' },
          limit: MAX_HOME_AGENTS,
        }),
      }),
    [projectId],
  );
  const { data: agents = [] } = useEntitiesQuery<Agent>(request, { enabled: !!projectId });
  return { agents };
}
