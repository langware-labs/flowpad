import { useMemo } from 'react';
import { ExpressionNode, Markdown, QueryFilter, QueryRequest } from '@sdk';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { useProject } from '@src/hooks/useProject';

/** Bounded because the pane is a picker, not a browser — the Docs section is a
 *  short list to choose from, and an unbounded project doc corpus would make it
 *  unusable long before it made it slow. */
const DOC_LIMIT = 500;

/**
 * The current project's docs (`markdown`).
 *
 * Unlike `skill`, `markdown` reliably carries `project_id`, so the live entity
 * query is correct here — the same shape `useProjectTasks` uses. `order_by` and
 * `limit` go INSIDE the `QueryFilter`: a top-level key would be folded into
 * `match` and become a field predicate matching nothing.
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
