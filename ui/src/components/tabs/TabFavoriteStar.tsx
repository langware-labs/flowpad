import { FavoriteStar } from '@src/components/favorites/FavoriteStar';
import { useFavorites, type FavoriteRef } from '@src/hooks/use-favorites';
import { animatePointToBookmarks } from '@src/lib/minimize-to-element';
import { cn } from '@src/lib/utils';

/**
 * A tab's own bookmark toggle, at the chip's leading edge — the navigation bar's
 * star for THIS tab, whichever tab is active. Same `FavoriteRef`, so the two
 * stars light together.
 *
 * Off, it stays out of the way until the chip is hovered; on, it is always
 * shown. Turning it ON flies a copy of the chip into the bar's bookmarks star:
 * nothing moved, the flight just says "that is where it is saved".
 */
export function TabFavoriteStar({ favorite, chip }: { favorite: FavoriteRef; chip: () => HTMLElement | null }) {
  const { isFavorited } = useFavorites();
  const on = !!isFavorited(favorite.entityType, favorite.entityId);
  return (
    // The chip drags on pointer-down and selects on click; a star press must do neither.
    <span
      className={cn('inline-flex shrink-0', !on && 'opacity-0 transition-opacity group-hover:opacity-60 hover:!opacity-100')}
      onPointerDown={(e) => e.stopPropagation()}
      data-testid="tab-favorite-star"
      data-favorited={on ? 'true' : undefined}
    >
      <FavoriteStar
        {...favorite}
        hoverSurface="none"
        size={12}
        // Off and hovered, a 12px amber outline is too faint to read as a target
        // on the chip: brighten it, thicken the stroke and tint the inside.
        className={cn(
          'p-0',
          !on &&
            'hover:text-amber-600 hover:[&_svg]:fill-amber-500/40 hover:[&_svg]:stroke-[2.5] dark:hover:text-amber-300 dark:hover:[&_svg]:fill-amber-300/40',
        )}
        onFavorited={() => animatePointToBookmarks(chip())}
      />
    </span>
  );
}
