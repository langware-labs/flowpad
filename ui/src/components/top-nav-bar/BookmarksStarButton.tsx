import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { BookmarksSlider } from '@src/components/bookmarks-slider/BookmarksSlider';
import { compactEntityActionClassName } from '@src/components/entity-actions/action-button-styles';
import { FavoriteStar } from '@src/components/favorites/FavoriteStar';
import { NavBadge } from '@src/components/ui/nav-badge';
import { viewportInlineEndGap } from '@src/components/ui/anchored-menu';
import { useLocaleInfo } from '@src/contexts/locale-context';
import { useHoverIntent } from '@src/hooks/use-hover-intent';
import { isHubOnly } from '@src/navigation/hub-runtime';
import { useUnopenedFavoritesCount } from '@src/hooks/use-unopened-favorites-count';
import type { FavoriteRef } from '@src/hooks/use-favorites';

/** Gap between the bar and the menu's top edge. */
const MENU_GAP = 4;

/**
 * The navigation bar's bookmarks button — a browser's, in both halves of its
 * behaviour: CLICK bookmarks the current thing, HOVER browses the ones you have.
 *
 * The two never collide because they are different gestures on the same glyph,
 * and because the star's own hover surfaces are handed over
 * (`hoverSurface="none"`): its rename card would otherwise open at 300ms, on top
 * of a menu that opens at 500ms. Rename and Remove stay on right-click.
 *
 * The hover intent is SHARED with the panel, which is what lets the pointer
 * travel from the star into the menu without dismissing it — they are disjoint
 * subtrees, so the star's pointerleave fires before the panel's pointerenter.
 *
 * This replaces the rail's Bookmarks icon, which was a second door to the same
 * menu a few pixels from the star that bookmarks the page.
 */
export function BookmarksStarButton({ favorite }: { favorite: FavoriteRef }) {
  const menu = useHoverIntent(); // 500ms rest-to-open, 500ms leave grace
  const unopened = useUnopenedFavoritesCount();
  // The hub has no `bookmark` entity — every query behind this menu 422s there.
  // Runtime-shaped (`isHubOnly`), not page-shaped: the rail used `hubMode`
  // (`currentDock.page === HUB`), which asks a different question and would let
  // the menu open on a hub-only build the moment you left the hub page. The
  // star still renders; only the menu it would open is withheld.
  const bookmarksAvailable = !isHubOnly();
  const triggerRef = useRef<HTMLSpanElement>(null);
  const [anchor, setAnchor] = useState<{ top: number; end: number }>();
  // The nav bar mirrors under HE/AR, which puts this star near the viewport's
  // LEFT edge — so the gap the menu anchors by has to be measured from whichever
  // edge is inline-end for the active locale, not from `right` unconditionally.
  const dir = useLocaleInfo().dir;

  // The menu hangs BELOW the bar with its inline-end edge on the star's. Measured
  // rather than a constant: the star's x moves with the breadcrumb and the
  // action cluster beside it.
  // `useCallback` over `dir`, not a bare closure: the effect below both calls
  // this and registers it as a listener, so it has to be a dep — and an
  // unmemoised function would re-run the effect (rebinding `resize`) on every
  // single render.
  const measure = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setAnchor({ top: rect.bottom + MENU_GAP, end: viewportInlineEndGap(rect, dir) });
  }, [dir]);

  // Measured before paint, and re-measured only while the menu is showing — a
  // resize listener that runs when nothing is open is work for nobody. It
  // re-runs when `dir` changes (via `measure`) because switching locale with the
  // menu open flips which edge that gap is measured from; a stale value would
  // leave the panel anchored to the edge the trigger just left.
  useLayoutEffect(() => {
    if (!menu.open) return;
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [menu.open, measure]);

  return (
    <>
      {/* `data-anchored-menu-ignore`: the panel dismisses on outside pointer-down,
          and without this the click that toggles the favorite would also read as
          "outside", closing a menu the same gesture is about to reopen. */}
      <span
        ref={triggerRef}
        {...menu.hoverProps}
        data-anchored-menu-ignore
        data-testid="top-nav-bookmarks-star"
        className="relative inline-flex shrink-0"
      >
        <FavoriteStar {...favorite} hoverSurface="none" size={14} className={`${compactEntityActionClassName} p-0`} />
        <NavBadge count={unopened} className="-end-0.5 -top-0.5 h-3.5 min-w-3.5" />
      </span>
      {bookmarksAvailable && (
        <BookmarksSlider
          open={menu.open}
          onOpenChange={menu.set}
          hoverProps={menu.hoverProps}
          anchorTop={anchor?.top}
          anchorEnd={anchor?.end}
        />
      )}
    </>
  );
}
