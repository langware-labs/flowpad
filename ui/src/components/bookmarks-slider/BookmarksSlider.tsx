import { useLingui } from '@lingui/react/macro';
import { FavoritesTreeMenu } from '@src/components/favorites/FavoritesTreeMenu';
import { useFavoritesScope } from '@src/components/favorites/use-favorites-scope';
import { LeftSlider } from '@src/components/ui/left-slider';
import { useCloseOnNavigate } from '@src/hooks/use-close-on-navigate';
import { useFavorites } from '@src/hooks/use-favorites';
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
  anchorTop,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Viewport y of the rail button, so the menu aligns to what opened it. */
  anchorTop?: number;
  /** The SAME hover intent as the rail button's, so travelling from the button
   *  into the panel cancels the pending close instead of dismissing. Required,
   *  not optional: this component turns the idle auto-close OFF, so hover IS
   *  the close. Omitting it wouldn't degrade gracefully — the panel would
   *  simply never close on leave. */
  hoverProps: { onPointerEnter: PointerEventHandler; onPointerLeave: PointerEventHandler };
}) {
  const { t } = useLingui();
  const { filter, scopeKey, scopeBar } = useFavoritesScope();
  const { reapDead } = useFavorites();
  useCloseOnNavigate(open, () => onOpenChange(false));
  // Opening the bookmarks menu is when we clean house: hard-delete any dead
  // ("ghost") favorites whose target no longer resolves, so they neither linger
  // in the store nor flash on screen. Idempotent — a no-op once none are left.
  useEffect(() => {
    if (open) void reapDead();
  }, [open, reapDead]);
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
      anchorTop={anchorTop}
      idleMs={null}
      onPointerEnter={hoverProps.onPointerEnter}
      onPointerLeave={hoverProps.onPointerLeave}
    >
      <FavoritesTreeMenu key={scopeKey} filter={filter} />
    </LeftSlider>
  );
}
