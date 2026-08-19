import { Agent, Project, QueryFilter, QueryRequest } from '@sdk';
import { useEntitiesQuery } from '@sdk/react/hooks';
import { useMemo } from 'react';

/** How many agents a home surface will show. The two vibe heroes center their
 *  column inside `overflow-hidden`, so an unbounded grid does not scroll — it
 *  is silently clipped. Bound it in the QUERY (not a `.slice()`) so the cap is
 *  one fact rather than a render-time trim. */
const MAX_HOME_AGENTS = 8;

/** The project's own root followed by its context-folder roots — the same
 *  boundary `Project.direct_context_roots()` draws server-side for the other
 *  features that must see into an attached project (helpdesk resolution,
 *  journey auto-launch). Sorted and de-duped because this list becomes part of
 *  the query, and the query IS the cache key. */
function agentSearchDirs(project?: Project | null): string[] {
  const raw = [project?.fs_storage_mount_path, ...(project?.include_dirs ?? [])];
  const dirs = raw
    .filter((d): d is string => typeof d === 'string' && d.length > 0)
    .map((d) => d.replace(/\/+$/, ''))
    .filter(Boolean);
  return [...new Set(dirs)].sort();
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
 * one of these roots is the thing that actually means "this project can use it".
 *
 * This is the same half-open lex range `Entity.assets_by_path` uses server-side
 * (`asset_ref >= "<dir>/" AND asset_ref < "<dir>0"`, OR'd across dirs), built
 * here instead of called through `/assets/by-path` because that route returns a
 * slim projection — no `avatar`, `title` or `enabled`, which is most of what a
 * tile renders. Pushed down to the existing index on
 * `json_extract(data,'$.asset_ref')`.
 *
 * `$OR` of `$AND`, never `$IN`: the client-side re-validator that keeps a
 * watched query live only evaluates `$IN` in its array-field (`$PROP`) form, so
 * a scalar `$IN` would silently stop new agents from appearing until a refetch.
 * Range leaves re-validate correctly, so a freshly indexed desk agent shows up
 * on its own — which is exactly the "attach the desk, the tile appears" moment.
 */
export function useProjectAgents(project?: Project | null) {
  const dirs = agentSearchDirs(project);
  // The dirs drive both the query and its identity, so key the memo on their
  // content — a new array each render would rebuild the request forever.
  const dirsKey = dirs.join('|');
  const request = useMemo(
    () =>
      new QueryRequest({
        type: Agent.type,
        scope: [],
        name: `projectAgents:${dirsKey}`,
        // `order_by`/`limit` belong INSIDE QueryFilter: `QueryFilter.parse`
        // wraps a bare dict wholesale into `match`, so a top-level key would
        // silently become a field predicate matching nothing. Alphabetical, not
        // created-date — a launcher that reshuffles as agents are added is
        // disorienting.
        query: new QueryFilter({
          match: {
            op: '$OR',
            operands: dirsKey.split('|').map((dir) => ({
              op: '$AND',
              operands: [
                { op: '$GE', operands: ['asset_ref', `${dir}/`] },
                { op: '$LT', operands: ['asset_ref', `${dir}0`] },
              ],
            })),
          } as unknown as Record<string, unknown>,
          order_by: { name: 'asc' },
          limit: MAX_HOME_AGENTS,
        }),
      }),
    [dirsKey],
  );
  const { data: agents = [] } = useEntitiesQuery<Agent>(request, { enabled: dirsKey.length > 0 });
  return { agents };
}
