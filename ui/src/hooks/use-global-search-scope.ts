import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAllProjects } from '@src/hooks/use-all-projects';
import type { ScopeFilter } from '@src/lib/scope-filter';
import type { SearchScopeMode } from '@src/components/record-search-bar/SearchScopeToggle';

interface UseGlobalSearchScopeOptions {
  enabled?: boolean;
}

/**
 * Default scope for user-facing global search surfaces.
 *
 * Search is a discovery surface, so it should start with user records plus
 * every known non-system project from the same unified project list used by
 * the footer picker.
 */
export function useGlobalSearchScope({
  enabled = true,
}: UseGlobalSearchScopeOptions = {}): { scope: ScopeFilter; isLoading: boolean } {
  const { projects, isLoading } = useAllProjects({ enabled });

  const scope = useMemo<ScopeFilter>(() => {
    const ids = new Set<string>();
    for (const project of projects) {
      if (project.id) ids.add(project.id);
    }
    return { user: true, projects: [...ids] };
  }, [projects]);

  return { scope, isLoading };
}

export function currentProjectOnlySearchScope(currentProjectId: string): ScopeFilter {
  return { user: false, projects: [currentProjectId] };
}

export function useSearchScopeToggle(
  currentProjectId: string | null,
  options: UseGlobalSearchScopeOptions = {},
): {
  scope: ScopeFilter;
  isLoading: boolean;
  mode: SearchScopeMode;
  setMode: (next: SearchScopeMode) => void;
  allProjectCount: number;
  currentProjectAvailable: boolean;
} {
  const { scope: allProjectsScope, isLoading: allProjectsLoading } = useGlobalSearchScope(options);
  const [mode, setModeState] = useState<SearchScopeMode>('all');
  const currentProjectAvailable = !!currentProjectId;

  useEffect(() => {
    if (!currentProjectAvailable && mode === 'current') setModeState('all');
  }, [currentProjectAvailable, mode]);

  const setMode = useCallback((next: SearchScopeMode) => {
    if (next === 'current' && !currentProjectId) {
      setModeState('all');
      return;
    }
    setModeState(next);
  }, [currentProjectId]);

  const currentScope = useMemo(
    () => (currentProjectId ? currentProjectOnlySearchScope(currentProjectId) : allProjectsScope),
    [allProjectsScope, currentProjectId],
  );

  const scope = mode === 'current' ? currentScope : allProjectsScope;
  const isLoading = mode === 'all' && allProjectsLoading;

  return {
    scope,
    isLoading,
    mode,
    setMode,
    allProjectCount: allProjectsScope.projects.length,
    currentProjectAvailable,
  };
}
