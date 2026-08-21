import { useCallback, useMemo } from 'react';
import { DataSourceSpec, QueryRequest } from '@sdk';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';

/**
 * The installed source definitions, and a lookup by name.
 *
 * Global by construction (`scope: []`) for the same reason `DataSource` is: a
 * definition is a property of the instance, not of a project, and switching
 * project must not change which sources exist.
 *
 * This is what replaced the hardcoded provider catalog. The dialog now renders
 * whatever is installed, so adding a source is an asset — not a frontend release.
 */
const specsQuery = new QueryRequest({
  type: DataSourceSpec.type,
  scope: [],
  name: 'data-sources:specs',
});

/** Stable while loading — a fresh `[]` per render would change `specFor`'s
 *  identity and re-trigger the dialog effect that depends on it. */
const EMPTY: DataSourceSpec[] = [];

export function useSourceSpecs() {
  const { data: specs = EMPTY } = useEntitiesQuery<DataSourceSpec>(specsQuery);
  // `name` is the registry key AND the folder name AND the asset id — one noun,
  // so a lookup needs nothing else.
  const byName = useMemo(() => new Map(specs.map((s) => [s.name, s])), [specs]);
  const specFor = useCallback((provider: string) => byName.get(provider), [byName]);
  return { specs, specFor };
}
