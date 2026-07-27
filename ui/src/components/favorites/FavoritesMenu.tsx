import { DesktopSurface } from '@src/components/quick-create/DesktopSurface';
import { useFavoritesScope } from './use-favorites-scope';

/**
 * FavoritesMenu — the favorites desktop as a GRID: scope filter pinned on top,
 * DesktopSurface (tiles + "+" quick-create + drag-to-arrange) below.
 *
 * This is the file-manager-shaped surface, for arranging favorites. Its home is
 * the favorites-edit dialog. The bookmarks slider deliberately does NOT use it —
 * a fast hover menu wants rows, not an icon desktop (see FavoritesTreeMenu).
 *
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
  const { filter, scopeBar } = useFavoritesScope();

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex items-center justify-end">{scopeBar}</div>
      <DesktopSurface size={size} filter={filter} selectedKey={selectedKey} />
    </div>
  );
}
