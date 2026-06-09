import { useEffect, useState } from 'react';
import { dataContext } from '@sdk';
import { defaultScopeFilter, type ScopeFilter } from '@src/lib/scope-filter';

/** Tracks the dataContext.project's id and emits a freshly-seeded ScopeFilter
 *  whenever the active project changes. Returns [scope, setScope, currentProjectId]. */
export function useDefaultScopeFilter(): [ScopeFilter, (s: ScopeFilter) => void, string | null] {
  const currentProjectId = dataContext.project?.id ?? null;
  const [scope, setScope] = useState<ScopeFilter>(() => defaultScopeFilter(currentProjectId));
  useEffect(() => {
    setScope(defaultScopeFilter(currentProjectId));
  }, [currentProjectId]);
  return [scope, setScope, currentProjectId];
}
