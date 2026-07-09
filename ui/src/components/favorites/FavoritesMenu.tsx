import type { Bookmark } from '@sdk';
import { DesktopSurface } from '@src/components/quick-create/DesktopSurface';
import { ScopeFilterIconBar } from '@src/components/scope-filter/ScopeFilterIconBar';
import { useDefaultScopeFilter } from '@src/hooks/use-default-scope-filter';
import { useProject } from '@src/hooks/useProject';
import { bookmarkInScope } from '@src/lib/bookmark-scope';
import { useCallback } from 'react';

/**
 * FavoritesMenu — the ONE favorites menu, container-agnostic. Rendered inside
 * both the left rail flyout (BookmarksSlider) and the favorites-edit dialog
 * (FavoritesEditDialog): scope filter pinned on top, the favorites desktop grid
 * (DesktopSurface — grid + "+" quick-create + drag-and-drop) below.
 *
 * Owns its scope LOCALLY (useDefaultScopeFilter) rather than via the URL, so
 * toggling scope never churns the dock (which the container watches to close).
 * Uses the grid's default navigation (navigation.openDock); the container
 * decides close-on-navigate (see useCloseOnNavigate).
 */
export function FavoritesMenu({
  selectedKey,
  size = 'default',
}: {
  /** Highlight a favorite by its bookmark id (id-based — any type, incl. non-navigable). */
  selectedKey?: string;
  size?: 'default' | 'large';
}) {
  const { project } = useProject();
  const [scope, setScope, currentProjectId] = useDefaultScopeFilter();

  const filter = useCallback(
    (b: Bookmark) => bookmarkInScope(b, scope, currentProjectId),
    [scope, currentProjectId],
  );

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex items-center justify-end">
        <ScopeFilterIconBar
          scope={scope}
          currentProjectId={currentProjectId}
          currentProjectName={project?.getDisplayName?.() ?? project?.name ?? null}
          onScopeChange={setScope}
        />
      </div>
      <DesktopSurface size={size} filter={filter} selectedKey={selectedKey} />
    </div>
  );
}
