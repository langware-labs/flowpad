/**
 * The tab strip's scanner: the hovered tab, widened in place to its full title.
 *
 * With many tabs a chip shows little or none of its title, so sliding the
 * pointer along the strip has to read title after title. The widened tab is a second rendering of the
 * same chip, drawn OVER the strip rather than in it — the chips never move. It
 * keeps the chip's END edge, where the close button sits, and widens toward the
 * row's start: the buttons under the pointer stay exactly where they were.
 *
 * This file is the geometry and the placement; `TabStrip` renders the chip.
 */
const SCAN_TAB_MAX_PX = 320;
const WIDEN_MS = 140;

/** What the strip measured when the pointer entered the chip. */
export interface ScanAnchor {
  chip: Pick<DOMRect, 'left' | 'right' | 'top' | 'height'>;
  /** The tab row — the widened tab never leaves it. */
  row: { left: number; right: number };
  dir: 'ltr' | 'rtl';
  viewportPx: number;
}

/**
 * The fixed box of a tab that wants to be `widthPx` wide: it keeps the chip's
 * END edge and grows toward the row's start, no wider than the room there is.
 */
export function scanTabBox({ chip, row, dir, viewportPx }: ScanAnchor, widthPx: number) {
  const roomPx = dir === 'rtl' ? row.right - chip.left : chip.right - row.left;
  return {
    top: `${chip.top}px`,
    height: `${chip.height}px`,
    width: `${Math.max(Math.min(widthPx, roomPx), chip.right - chip.left)}px`,
    left: dir === 'rtl' ? `${chip.left}px` : '',
    right: dir === 'rtl' ? '' : `${viewportPx - chip.right}px`,
  };
}

/** Puts the widened tab over its chip and animates it open from the chip's width. */
export function placeScanTab(el: HTMLElement, anchor: ScanAnchor): void {
  const chipPx = anchor.chip.right - anchor.chip.left;
  // Unset, a fixed box shrinks to its content: that is the tab's natural width.
  Object.assign(el.style, { left: '', right: '', width: '', maxWidth: `${SCAN_TAB_MAX_PX}px` });
  const style = scanTabBox(anchor, el.offsetWidth);
  Object.assign(el.style, style);
  if (typeof el.animate === 'function' && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    el.animate([{ width: `${chipPx}px` }, { width: style.width }], { duration: WIDEN_MS, easing: 'ease-out' });
  }
}
