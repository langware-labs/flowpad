import { Agent, ExpressionNode, Project, QueryFilter, QueryRequest } from '@sdk';
import { useEntitiesQuery } from '@sdk/react/hooks';
import { useMemo } from 'react';

/** How many agents a home surface will show. The two vibe heroes center their
 *  column inside `overflow-hidden`, so an unbounded grid does not scroll — it
 *  is silently clipped. Bound it in the QUERY (not a `.slice()`) so the cap is
 *  one fact rather than a render-time trim. */
const MAX_HOME_AGENTS = 8;

/** The half-open `[<dir><sep>, <dir><next>)` pair `Entity.assets_by_path` uses
 *  server-side, where `next` is the codepoint after the separator — so a dir
 *  matches exactly its strict descendants. */
function prefixRange(dir: string, sep: string, next: string): ExpressionNode {
  return new ExpressionNode({
    op: '$AND',
    operands: [
      new ExpressionNode({ op: '$GE', operands: ['asset_ref', `${dir}${sep}`] }),
      new ExpressionNode({ op: '$LT', operands: ['asset_ref', `${dir}${next}`] }),
    ],
  });
}

/**
 * Every `asset_ref` prefix range a stored row may match for `dir`, which arrives
 * from `context_roots` in canonical POSIX form (`C:/Users/…` on Windows).
 *
 * **One range per SEPARATOR SPELLING, and they are OR'd** — the rule
 * `Entity.assets_by_path` already states server-side, for the same reason: the
 * comparison is lexical, so a range only matches rows written in its own form,
 * and on Windows BOTH forms are in the data. The indexer writes `asset_ref`
 * through pathlib (backslashes) while `context_roots` and the other producers
 * write `canonical_posix_path`. A POSIX-only range therefore matched nothing on
 * Windows — `\` (0x5C) sorts past the `0` (0x30) that closes it — so a
 * project's agents were invisible on its homes there while the identical
 * project worked on macOS.
 *
 * Only a drive-lettered or UNC root gets the second range: those are the paths
 * pathlib spells with `\`, and a POSIX root has no other spelling to add.
 */
function underDir(dir: string): ExpressionNode[] {
  // "/" is 0x2F -> "0"; "\" is 0x5C -> "]".
  const ranges = [prefixRange(dir, '/', '0')];
  if (/^(?:[A-Za-z]:\/|\/\/)/.test(dir)) ranges.push(prefixRange(dir.replace(/\//g, '\\'), '\\', ']'));
  return ranges;
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
          match: new ExpressionNode({ op: '$OR', operands: roots.flatMap(underDir) }),
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
