import { useLingui } from '@lingui/react/macro';
import { FavoritesTreeMenu } from '@src/components/favorites/FavoritesTreeMenu';
import { useFavoritesScope } from '@src/components/favorites/use-favorites-scope';
import { LeftSlider } from '@src/components/ui/left-slider';
import { useCloseOnNavigate } from '@src/hooks/use-close-on-navigate';
import { useEffect, type PointerEventHandler } from 'react';

/**
 * BookmarksSlider — the rail flyout: a fast, hover-driven bookmarks MENU.
 * LeftSlider provides the rail-anchored chrome, FavoritesTreeMenu the rows.
 *
 * Dismissal is fully owned by hover (`hoverProps`, shared with the rail button
 * that opens it) plus Escape / outside pointer-down / close-on-navigate / window
 * blur — so the idle auto-close is switched OFF (`idleMs={null}`). Those two are
 * genuinely opposed: idle-close listens on the window, so a pointer parked
 * inside the panel to read it emits no movement and would have the panel yanked
 * away at 5s, by the very pointer holding it open.
 *
 * Clicking a bookmark navigates and closes (useCloseOnNavigate covers both the
 * pointer and imperative activate arms).
 */
export function BookmarksSlider({
  open,
  onOpenChange,
  hoverProps,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The SAME hover intent as the rail button's, so travelling from the button
   *  into the panel cancels the pending close instead of dismissing. */
  hoverProps?: { onPointerEnter: PointerEventHandler; onPointerLeave: PointerEventHandler };
}) {
  const { t } = useLingui();
  const { filter, scopeBar } = useFavoritesScope();
  useCloseOnNavigate(open, () => onOpenChange(false));
  useEffect(() => {
    if (!open) return;
    const close = () => onOpenChange(false);
    const closeWhenHidden = () => {
      if (document.visibilityState === 'hidden') close();
    };
    window.addEventListener('blur', close);
    document.addEventListener('visibilitychange', closeWhenHidden);
    return () => {
      window.removeEventListener('blur', close);
      document.removeEventListener('visibilitychange', closeWhenHidden);
    };
  }, [open, onOpenChange]);

  return (
    <LeftSlider
      open={open}
      onOpenChange={onOpenChange}
      title={t`Bookmarks`}
      // LeftSlider documents headerRight as the canonical scope-filter home;
      // the menu body is rows only.
      headerRight={scopeBar}
      idleMs={null}
      onPointerEnter={hoverProps?.onPointerEnter}
      onPointerLeave={hoverProps?.onPointerLeave}
    >
      <FavoritesTreeMenu filter={filter} />
    </LeftSlider>
  );
}
