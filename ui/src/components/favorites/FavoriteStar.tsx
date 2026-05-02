import { cn } from '@src/lib/utils';
import { useFavorites, type FavoriteRef } from '@src/hooks/use-favorites';
import { Star } from 'lucide-react';
import { useCallback } from 'react';

interface FavoriteStarProps extends FavoriteRef {
  className?: string;
  size?: number;
}

/**
 * Generic star toggle. Drop into any entity row/card:
 *   <FavoriteStar entityType="project" entityId={p.id} title={p.displayName} />
 *
 * Click fills the star and persists a Bookmark(bookmark_type='favorite').
 * Clicking a filled star hard-deletes the bookmark record.
 */
export function FavoriteStar({
  entityType,
  entityId,
  title,
  icon,
  nav,
  className,
  size = 16,
}: FavoriteStarProps) {
  const { isFavorited, toggleFavorite } = useFavorites();
  const favorited = !!isFavorited(entityType, entityId);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      void toggleFavorite({ entityType, entityId, title, icon, nav });
    },
    [toggleFavorite, entityType, entityId, title, icon, nav],
  );

  return (
    <button
      type="button"
      aria-label={favorited ? 'Remove from favorites' : 'Add to favorites'}
      title={favorited ? 'Remove from favorites' : 'Add to favorites'}
      onClick={handleClick}
      className={cn(
        'inline-flex items-center justify-center rounded p-1 text-muted-foreground transition-colors hover:text-amber-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        favorited && 'text-amber-500',
        className,
      )}
    >
      <Star
        width={size}
        height={size}
        className={cn(favorited && 'fill-amber-500')}
      />
    </button>
  );
}
