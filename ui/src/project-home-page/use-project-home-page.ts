import { QueryFilter, QueryRequest, RecordType, TypeId, isTypeId, systemTools, type ProjectManifest } from '@sdk';
import { useEntitiesQuery } from '@sdk/react/hooks';
import { useEffect, useMemo, useState } from 'react';

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

const typeIdOrNull = (value: string): TypeId | null => (isTypeId(value) ? new TypeId(value) : null);

/**
 * The asset a declared home page names, for showing it — never throws.
 *
 * The declaration is an asset TypeId or a `./path` inside the project
 * (docs/navigation/project-home-page.md). A path is classified by the backend's
 * path resolver (`systemTools.resolveByPath`), so every clone shows its own
 * local asset. `missing` when the declaration names no asset here — including
 * a value only a hand edit could produce (`agent:<uuid>`).
 */
export function useHomePageTypeId(
  projectRoot: string | null | undefined,
  declaration: string | null,
): { typeId: TypeId | null; missing: boolean } {
  const direct = useMemo(() => (declaration ? typeIdOrNull(declaration) : null), [declaration]);
  const path =
    !direct && declaration?.startsWith('./') && projectRoot
      ? `${projectRoot.replace(/[\\/]+$/, '')}/${declaration.slice(2)}`
      : null;
  const [resolved, setResolved] = useState<{ path: string; typeId: TypeId | null } | null>(null);
  useEffect(() => {
    if (!path) return;
    let live = true;
    const settle = (typeId: TypeId | null) => live && setResolved({ path, typeId });
    systemTools.resolveByPath(path).then(
      (asset) => settle(asset ? typeIdOrNull(`${asset.type}${TypeId.DELIMITER}${asset.id}`) : null),
      () => settle(null),
    );
    return () => {
      live = false;
    };
  }, [path]);

  if (!declaration) return { typeId: null, missing: false };
  if (direct) return { typeId: direct, missing: false };
  if (path && resolved?.path !== path) return { typeId: null, missing: false }; // still resolving
  const typeId = path ? (resolved?.typeId ?? null) : null;
  return { typeId, missing: !typeId };
}
