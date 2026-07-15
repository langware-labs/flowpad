import { useLingui } from '@lingui/react/macro';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { FavoritesMenu } from '@src/components/favorites/FavoritesMenu';
import { useCloseOnNavigate } from '@src/hooks/use-close-on-navigate';

/**
 * FavoritesEditDialog — the home of the favorites GRID (FavoritesMenu), as a
 * centered modal dialog for editing/rearranging favorites (drag-and-drop, folder
 * creation via the grid's "+" tile). Opens with a favorite pre-SELECTED by id
 * (`selectedFavoriteId`), reusable across all favorite types (assets, sessions,
 * …). Unlike the LeftSlider flyout it does NOT auto-close on idle — it closes
 * only on the X / outside-click / Escape (Radix Dialog), or when a favorite is
 * clicked (useCloseOnNavigate).
 */
export function FavoritesEditDialog({
  open,
  onOpenChange,
  selectedFavoriteId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedFavoriteId?: string | null;
}) {
  const { t } = useLingui();
  useCloseOnNavigate(open, () => onOpenChange(false));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t`Edit favorites`}</DialogTitle>
          <DialogDescription className="sr-only">
            {t`Rearrange favorites, create folders, and organize your bookmarks.`}
          </DialogDescription>
        </DialogHeader>
        <FavoritesMenu size="large" selectedKey={selectedFavoriteId ?? undefined} />
      </DialogContent>
    </Dialog>
  );
}
