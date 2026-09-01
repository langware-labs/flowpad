import { useMemo } from 'react';
import { ExpressionNode, Markdown, QueryFilter, QueryRequest } from '@sdk';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { useProject } from '@src/hooks/useProject';

/** Bounded because the pane is a picker, not a browser — the Docs section is a
 *  short list to choose from, and an unbounded project doc corpus would make it
 *  unusable long before it made it slow. */
const DOC_LIMIT = 500;

/**
 * The project's docs. Unlike `skill`, `markdown` carries `project_id`, so the
 * live query is correct. `order_by`/`limit` go INSIDE `QueryFilter` — a
 * top-level key folds into `match` and becomes a predicate matching nothing.
 */
export function useProjectDocs(): { docs: Markdown[]; isLoading: boolean } {
  const { project } = useProject();
  const projectId = project?.id;

  const request = useMemo(
    () =>
      new QueryRequest({
        type: Markdown.type,
        scope: [],
        name: 'agentResources:docs',
        query: new QueryFilter({
          match: new ExpressionNode({ project_id: projectId ?? '' }),
          order_by: { title: 'asc' },
          limit: DOC_LIMIT,
        }),
      }),
    [projectId],
  );

  const { data: docs = [], isLoading } = useEntitiesQuery<Markdown>(request, { enabled: !!projectId });

  return { docs, isLoading: !!projectId && isLoading };
}
