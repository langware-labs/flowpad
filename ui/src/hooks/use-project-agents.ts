import { Agent, ExpressionNode, Project, QueryFilter, QueryRequest } from '@sdk';
import { useEntitiesQuery } from '@sdk/react/hooks';
import { useMemo } from 'react';

/** How many agents a home surface will show. The two vibe heroes center their
 *  column inside `overflow-hidden`, so an unbounded grid does not scroll — it
 *  is silently clipped. Bound it in the QUERY (not a `.slice()`) so the cap is
 *  one fact rather than a render-time trim. */
const MAX_HOME_AGENTS = 8;

/** One `asset_ref` prefix range — the half-open `[<dir>/, <dir>0)` pair
 *  `Entity.assets_by_path` uses server-side (`/` is 0x2F, `0` the next
 *  codepoint), so a dir matches exactly its strict descendants. */
function underDir(dir: string): ExpressionNode {
  return new ExpressionNode({
    op: '$AND',
    operands: [
      new ExpressionNode({ op: '$GE', operands: ['asset_ref', `${dir}/`] }),
      new ExpressionNode({ op: '$LT', operands: ['asset_ref', `${dir}0`] }),
    ],
  });
}

/**
 * The `Agent` assets this project can launch — its own, plus every agent
 * supplied by a project attached to it as a context folder (a vendor help desk
 * shipping a support agent is the motivating case).
 *
 * NOT `SubAgent` (`.claude/agents/*.md`): that is the provider-owned prompt
 * asset `useVibeAgents` lists, which has no avatar and nothing to launch.
 *
 * **Membership is by PATH, not by `project_id`.** An agent the indexer
 * discovered inside an attached checkout is walked as a `scope="user"` root
 * with no project, so it carries `project_id = null` (or, if the checkout
 * happens to sit under an umbrella project's mount, that unrelated project's
 * id). A `project_id` match therefore cannot see a desk's agents at all — and
 * misses some of the project's OWN agents too, since only the create path
 * writes the `is_child` edge a project-scoped query walks. An asset_ref under
 * one of `project.context_roots` is what actually means "this project can use
 * it", which is why those roots come from the server rather than being
 * re-derived here.
 *
 * The range tree is built client-side rather than called through
 * `/assets/by-path` because that route returns a slim projection — no `avatar`,
 * `title` or `enabled`, which is most of what a tile renders — and is a one-shot
 * read with no subscription. `$OR` of `$AND`, never `$IN`: the client-side
 * re-validator that keeps a watched query live only evaluates `$IN` in its
 * array-field (`$PROP`) form, so a scalar `$IN` would silently stop new agents
 * from appearing until a refetch. Range leaves re-validate correctly, so a desk
 * attached while home is open makes its tile appear on its own.
 *
 * The request must also be IDENTICAL across mounts: `VibeSwap` keeps both home
 * branches mounted (`display:none`, not a conditional), so the strip mounts
 * twice at once on `/`. `QueryRequest.key` is built from `type`/`query`/`scope`
 * — `name` is not part of it — so matching those three is what makes the two
 * share one fetch and one subscription.
 */
export function useProjectAgents(project?: Project | null) {
  // Content-keyed: the roots drive both the query and its identity, and a fresh
  // array each render would rebuild the request forever.
  const rootsKey = (project?.context_roots ?? []).join('|');
  const request = useMemo(
    () => {
      const roots = rootsKey ? rootsKey.split('|') : [];
      return new QueryRequest({
        type: Agent.type,
        scope: [],
        name: `projectAgents:${project?.id ?? 'none'}`,
        // `order_by`/`limit` belong INSIDE QueryFilter: `QueryFilter.parse`
        // wraps a bare dict wholesale into `match`, so a top-level key would
        // silently become a field predicate matching nothing. Alphabetical, not
        // created-date — a launcher that reshuffles as agents are added is
        // disorienting.
        query: new QueryFilter({
          match: new ExpressionNode({ op: '$OR', operands: roots.map(underDir) }),
          order_by: { name: 'asc' },
          limit: MAX_HOME_AGENTS,
        }),
      });
    },
    // Keyed on the joined string, not on a split array rebuilt from it — the
    // array was only ever derived. `project?.id` stays because the request's
    // `name` embeds it, though it cannot change `QueryRequest.key`.
    [rootsKey, project?.id],
  );
  const { data: agents = [] } = useEntitiesQuery<Agent>(request, { enabled: rootsKey.length > 0 });
  return { agents };
}
