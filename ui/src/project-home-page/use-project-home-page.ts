import { Project, QueryFilter, QueryRequest, RecordType, TypeId, isTypeId, type ProjectManifest } from '@sdk';
import { useEntitiesQuery } from '@sdk/react/hooks';
import { useQuery } from '@tanstack/react-query';
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
  const { data } = useEntitiesQuery<ProjectManifest>(request, { enabled: !!projectId });
  return data?.[0]?.home_page ?? null;
}

const typeIdOrNull = (value: string | null | undefined): TypeId | null =>
  value && isTypeId(value) ? new TypeId(value) : null;

/**
 * The asset a declared home page names, for showing it — never throws.
 *
 * The declaration is an asset TypeId or a `./path` inside the project
 * (docs/navigation/project-home-page.md). A TypeId is used as is. Anything else
 * goes to the backend's `Project.resolve_home_page_typeid`
 * (`Project.resolveHomePageTypeId`), the one owner of the path rule: relative to
 * this checkout, and contained in it. So every clone shows its own local asset.
 * `missing` when the declaration names no asset here.
 */
export function useHomePageTypeId(
  projectId: string | null | undefined,
  declaration: string | null,
): { typeId: TypeId | null; missing: boolean } {
  const direct = useMemo(() => typeIdOrNull(declaration), [declaration]);
  const { data, isPending } = useQuery({
    queryKey: ['project-home-page-typeid', projectId, declaration],
    queryFn: () => Project.resolveHomePageTypeId(projectId!, declaration!),
    enabled: !!projectId && !!declaration && !direct,
    retry: false,
  });
  const resolved = useMemo(() => typeIdOrNull(data), [data]);

  if (!declaration) return { typeId: null, missing: false };
  if (direct) return { typeId: direct, missing: false };
  if (isPending) return { typeId: null, missing: false }; // still resolving
  return { typeId: resolved, missing: !resolved };
}
