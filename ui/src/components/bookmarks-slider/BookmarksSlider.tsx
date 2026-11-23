import { useLingui } from '@lingui/react/macro';
import { FavoritesTreeMenu } from '@src/components/favorites/FavoritesTreeMenu';
import { BookmarksNotesSection } from '@src/components/notes/BookmarksNotesSection';
import { AnchoredMenu } from '@src/components/ui/anchored-menu';
import { useCloseOnNavigate } from '@src/hooks/use-close-on-navigate';
import { useEffect, useState, type PointerEventHandler } from 'react';

/**
 * BookmarksSlider — a fast, hover-opened bookmarks MENU. AnchoredMenu provides the
 * anchored chrome, FavoritesTreeMenu the breadcrumb and the rows. Its host decides which edge it
 * grows from (`side`); today that is the navigation bar's star, expanding from
 * the top inline-end corner toward inline-start — so top-right-growing-leftward
 * under LTR, and top-left-growing-rightward under HE/AR.
 *
 * Dismissal is fully owned by hover (`hoverProps`, shared with the star that
 * opens it) plus Escape / outside pointer-down / close-on-navigate / window
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
  anchorEnd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Viewport y the menu's top edge aligns to, so it reads as belonging to the
   *  control that opened it. */
  anchorTop?: number;
  /** Distance from the viewport's inline-end edge — see AnchoredMenu. */
  anchorEnd?: number;
  /** The SAME hover intent as the trigger's, so travelling from the button
   *  into the panel cancels the pending close instead of dismissing. Required,
   *  not optional: this component turns the idle auto-close OFF, so hover IS
   *  the close. Omitting it wouldn't degrade gracefully — the panel would
   *  simply never close on leave. */
  hoverProps: { onPointerEnter: PointerEventHandler; onPointerLeave: PointerEventHandler };
}) {
  const { t } = useLingui();
  // The header slot the menu draws its breadcrumb into — see FavoritesTreeMenu.
  const [breadcrumbSlot, setBreadcrumbSlot] = useState<HTMLElement | null>(null);
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
    <AnchoredMenu
      open={open}
      onOpenChange={onOpenChange}
      title={<div ref={setBreadcrumbSlot} />}
      label={t`Bookmarks`}
      anchorTop={anchorTop}
      anchorEnd={anchorEnd}
      idleMs={null}
      onPointerEnter={hoverProps.onPointerEnter}
      onPointerLeave={hoverProps.onPointerLeave}
    >
      <FavoritesTreeMenu breadcrumbSlot={breadcrumbSlot} />
      <BookmarksNotesSection />
    </AnchoredMenu>
  );
}
