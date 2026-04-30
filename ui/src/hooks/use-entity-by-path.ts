import { APIEntity, FSRef, config } from '@sdk';
import { EntityFactory } from '@sdk/schema/factory';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

const stripLeadingSlash = (p: string | undefined | null): string =>
  p ? (p.startsWith('/') ? p.slice(1) : p) : '';

/**
 * Resolve the first-class entity whose `asset_ref` matches `fsRef`.
 * Returns null while loading or when no entity with this path exists.
 *
 * Used by the asset editors to bind chat / per-entity affordances to the real
 * entity TypeId instead of a path-keyed pseudo. Skill entities key on the
 * folder path; pass the folder FSRef in that case.
 *
 * Direct fetch with `include_system=true` so SDK-shipped system docs
 * (Welcome, Getting Started, etc.) resolve. The QueryRequest path used by
 * `useEntitiesQuery` doesn't expose that flag — same reason
 * `SkillsCategory.tsx` / `DocsCategory.tsx` bypass it. Raw JSON rows are
 * hydrated through `EntityFactory.createEntity` so callers get a real
 * APIEntity (with `typeId`, type-specific methods like `Skill.doc`).
 */
export function useEntityByPath<T extends APIEntity<T>>(
  entityType: string | null | undefined,
  fsRef: FSRef | null,
): { entity: T | null; isLoading: boolean } {
  const type = entityType ?? '';
  const enabled = !!type && !!fsRef;
  const { data = [], isLoading } = useQuery<T[]>({
    queryKey: [`${type}-by-path`, type],
    queryFn: async () => {
      const url = `${config.SERVER_URL}${config.API_PREFIXES.graph}/${type}?include_system=true&limit=5000`;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`failed to fetch ${type}: ${resp.status}`);
      const body = await resp.json();
      const rows = (body.data ?? []) as Array<Record<string, unknown> & { type?: string }>;
      const out: T[] = [];
      for (const row of rows) {
        if (!row.type) row.type = type;
        const inst = EntityFactory.createEntity(row as never) as T | undefined;
        if (inst) out.push(inst);
      }
      return out;
    },
    enabled,
    staleTime: 30_000,
  });
  const entity = useMemo(() => {
    if (!fsRef) return null;
    const needle = stripLeadingSlash(fsRef.path);
    return (
      data.find((e: unknown) => {
        const r = e as { asset_ref?: string };
        const p = stripLeadingSlash(r.asset_ref);
        return p !== '' && p === needle;
      }) ?? null
    );
  }, [data, fsRef]);
  return { entity, isLoading };
}
