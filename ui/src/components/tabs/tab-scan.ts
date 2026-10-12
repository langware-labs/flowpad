/**
 * The tab strip's scanner: the hovered tab, widened in place to its full title.
 *
 * With many tabs a chip shows little or none of its title, so sliding the
 * pointer along the strip has to read title after title. The widened tab is a second rendering of the
 * same chip, drawn OVER the strip rather than in it — the chips never move. A
 * scan runs from the row's end toward its start (leftward in LTR), so the tab
 * widens the other way, toward the end: over the tabs already passed, never
 * over the ones the pointer is heading for.
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
 * The fixed box of a tab `widthPx` wide. `forward`: it fits between the chip's
 * START edge and the row's end, so it keeps that edge and grows toward the end.
 * Otherwise it keeps the chip's END edge and grows back over the row.
 */
export function scanTabBox({ chip, row, dir, viewportPx }: ScanAnchor, widthPx: number) {
  const forward = widthPx <= (dir === 'rtl' ? chip.right - row.left : row.right - chip.left);
  // Pin the physical LEFT edge when growing rightward, the RIGHT edge otherwise.
  const pinLeft = forward === (dir === 'ltr');
  const style = {
    top: `${chip.top}px`,
    height: `${chip.height}px`,
    width: `${widthPx}px`,
    left: pinLeft ? `${chip.left}px` : '',
    right: pinLeft ? '' : `${viewportPx - chip.right}px`,
  };
  return { forward, style };
}

/**
 * Puts the widened tab over its chip and animates it open from the chip's width.
 *
 * Widened forward it covers only tabs the scan has passed, so it takes the
 * pointer and IS the tab. Widened back it lies over tabs still ahead, so it is
 * made see-through to the pointer (`isSeeThrough`): the chips under it keep
 * answering, and the scan can go on to them.
 */
export function placeScanTab(el: HTMLElement, anchor: ScanAnchor): void {
  const chipPx = anchor.chip.right - anchor.chip.left;
  // Unset, a fixed box shrinks to its content: that is the tab's natural width.
  Object.assign(el.style, { left: '', right: '', width: '', maxWidth: `${SCAN_TAB_MAX_PX}px` });
  const widthPx = Math.max(el.offsetWidth, chipPx);
  const { forward, style } = scanTabBox(anchor, widthPx);
  Object.assign(el.style, style, { pointerEvents: forward ? '' : 'none' });
  if (typeof el.animate === 'function' && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    el.animate([{ width: `${chipPx}px` }, { width: style.width }], { duration: WIDEN_MS, easing: 'ease-out' });
  }
}

export const isSeeThrough = (el: HTMLElement | null): boolean => el?.style.pointerEvents === 'none';
