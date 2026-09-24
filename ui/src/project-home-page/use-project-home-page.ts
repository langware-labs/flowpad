import { QueryFilter, QueryRequest, RecordType, type AnyEntity } from '@sdk';
import { useEntitiesQuery } from '@sdk/react/hooks';
import { useMemo } from 'react';

/**
 * The home page `projectId`'s manifest declares, or null.
 *
 * Read off the indexed `ProjectManifest` row — the projection of
 * `project_manifest.json`, which is where the home page lives — so a git pull
 * or another tab's change arrives the way every other row change does.
 * Declared, not resolved: `Project.openHomePage` (`GET project/<id>/home-page`)
 * checks it exists and belongs to this project.
 */
export function useProjectHomePage(projectId: string | null | undefined): string | null {
  const request = useMemo(
    () =>
      new QueryRequest({
        type: RecordType.PROJECT_MANIFEST,
        scope: [],
        name: `projectHomePage:${projectId ?? 'none'}`,
        query: new QueryFilter({ match: { project_id: projectId ?? '' } }),
      }),
    [projectId],
  );
  const { data } = useEntitiesQuery<AnyEntity>(request, { enabled: !!projectId });
  const row = data?.[0] as (AnyEntity & { home_page?: string | null }) | undefined;
  return row?.home_page ?? null;
}
