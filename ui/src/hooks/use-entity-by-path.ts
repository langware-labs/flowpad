import { APIEntity, FSRef, QueryRequest } from '@sdk';
import { useMemo } from 'react';
import { useEntitiesQuery } from './entity-hooks';

const stripLeadingSlash = (p: string | undefined | null): string =>
  p ? (p.startsWith('/') ? p.slice(1) : p) : '';

/**
 * Resolve the first-class entity whose `source_path` / `source_vfs_path` matches
 * `fsRef`. Returns null while loading or when no entity with this path exists.
 *
 * Used by the asset editors to bind chat / per-entity affordances to the real
 * entity TypeId instead of a path-keyed pseudo. Skill entities key on the
 * folder path; pass the folder FSRef in that case.
 */
export function useEntityByPath<T extends APIEntity<T>>(
  entityType: string | null | undefined,
  fsRef: FSRef | null,
): { entity: T | null; isLoading: boolean } {
  const type = entityType ?? '';
  const query = useMemo(
    () => new QueryRequest({ type: type || 'unknown' }),
    [type],
  );
  const { data = [], isLoading } = useEntitiesQuery<T>(query, {
    enabled: !!type && !!fsRef,
  });
  const entity = useMemo(() => {
    if (!fsRef) return null;
    const needle = stripLeadingSlash(fsRef.path);
    return (
      data.find((e: unknown) => {
        const r = e as { source_path?: string; source_vfs_path?: string };
        const p = stripLeadingSlash(r.source_path || r.source_vfs_path);
        return p !== '' && p === needle;
      }) ?? null
    );
  }, [data, fsRef]);
  return { entity, isLoading };
}
