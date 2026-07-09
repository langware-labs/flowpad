import { useLingui } from '@lingui/react/macro';
import { FavoritesMenu } from '@src/components/favorites/FavoritesMenu';
import { LeftSlider } from '@src/components/ui/left-slider';
import { useCloseOnNavigate } from '@src/hooks/use-close-on-navigate';

/**
 * BookmarksSlider — the rail flyout container for the shared FavoritesMenu (the
 * ONE favorites menu, also hosted by FavoritesEditDialog). LeftSlider provides
 * the rail-anchored chrome + idle auto-close; FavoritesMenu provides the scope
 * filter + favorites grid. Clicking a bookmark navigates and closes the slider
 * (useCloseOnNavigate covers both the pointer and imperative activate arms).
 */
export function BookmarksSlider({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useLingui();
  useCloseOnNavigate(open, () => onOpenChange(false));

  return (
    <LeftSlider open={open} onOpenChange={onOpenChange} title={t`Bookmarks`}>
      <FavoritesMenu />
    </LeftSlider>
  );
}
