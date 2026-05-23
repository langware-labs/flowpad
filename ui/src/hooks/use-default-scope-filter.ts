import { useEffect, useState } from 'react';
import { dataContext } from '@sdk';
import { projectIdForPath } from '@src/components/assets/utils';
import { defaultScopeFilter, type ScopeFilter } from '@src/lib/scope-filter';

/** Tracks the dataContext.project's id and emits a freshly-seeded ScopeFilter
 *  whenever the active project changes. Returns [scope, setScope, currentProjectId]. */
export function useDefaultScopeFilter(): [ScopeFilter, (s: ScopeFilter) => void, string | null] {
  const currentProjectId = projectIdForPath(dataContext.project?.fs_storage_mount_path) ?? null;
  const [scope, setScope] = useState<ScopeFilter>(() => defaultScopeFilter(currentProjectId));
  useEffect(() => {
    setScope(defaultScopeFilter(currentProjectId));
  }, [currentProjectId]);
  return [scope, setScope, currentProjectId];
}
