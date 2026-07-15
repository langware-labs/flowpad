import type { Bookmark } from '@sdk';
import { ScopeFilterIconBar } from '@src/components/scope-filter/ScopeFilterIconBar';
import { useDefaultScopeFilter } from '@src/hooks/use-default-scope-filter';
import { useProject } from '@src/hooks/useProject';
import { bookmarkInScope } from '@src/lib/bookmark-scope';
import { createElement, useCallback, type ReactNode } from 'react';

/**
 * Scope filtering for the favorites surfaces — the one thing the grid menu and
 * the tree menu genuinely share. They render nothing else in common (tiles vs
 * rows) and want the bar in different places (inline vs the slider's header
 * slot), which is why they're two components over one hook rather than one
 * component with a `variant` prop.
 *
 * Scope is LOCAL (not URL-derived) on purpose: toggling it must not churn the
 * dock, which the containers watch in order to close themselves.
 */
export function useFavoritesScope(): {
  filter: (b: Bookmark) => boolean;
  scopeBar: ReactNode;
} {
  const { project } = useProject();
  const [scope, setScope, currentProjectId] = useDefaultScopeFilter();

  const filter = useCallback(
    (b: Bookmark) => bookmarkInScope(b, scope, currentProjectId),
    [scope, currentProjectId],
  );

  const scopeBar = createElement(ScopeFilterIconBar, {
    scope,
    currentProjectId,
    currentProjectName: project?.getDisplayName?.() ?? project?.name ?? null,
    onScopeChange: setScope,
  });

  return { filter, scopeBar };
}
