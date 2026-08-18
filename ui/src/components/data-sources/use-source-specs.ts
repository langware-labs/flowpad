import { useCallback } from 'react';
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

export function useSourceSpecs() {
  const { data: specs = [] } = useEntitiesQuery<DataSourceSpec>(specsQuery);
  (window as any).__specsProbe = specs;
  // `name` is the registry key AND the folder name AND the asset id — one noun,
  // so a lookup needs nothing else.
  const specFor = useCallback(
    (provider: string) => specs.find((s) => s.name === provider),
    [specs],
  );
  return { specs, specFor };
}
