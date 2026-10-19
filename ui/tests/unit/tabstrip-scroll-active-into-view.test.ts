/**
 * The tab strip must keep the ACTIVE chip on screen.
 *
 * The strip uses the Chrome model — every chip shrinks equally so all stay
 * visible — but past a 40px-per-chip floor the row CLIPS (`overflow-hidden`).
 * Nothing ever scrolled it, so a selected tab beyond the fold was invisible AND
 * unreachable: no scrollbar to recover it, and the row pinned at scrollLeft 0.
 * Observed at 54 tabs: the active chip sat at x=2260 in an 815px row.
 *
 * The geometry is the subtle part. `offsetLeft` is relative to `offsetParent`,
 * which is NOT the scroll container (it is not positioned) — using it overshoots
 * and shoves the chip off the opposite edge. These tests pin the container-
 * relative arithmetic that replaced it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const SOURCE = readFileSync(
  path.resolve(__dirname, '../../src/components/tabs/TabStrip.tsx'),
  'utf8',
);

/** The exact arithmetic the effect performs, extracted so it can be exercised. */
function scrollLeftFor(opts: {
  chipLeft: number;
  chipWidth: number;
  scrollLeft: number;
  clientWidth: number;
  scrollWidth: number;
  pad?: number;
}): number {
  const { chipLeft, chipWidth, scrollLeft, clientWidth, scrollWidth } = opts;
  const pad = opts.pad ?? 24;
  if (scrollWidth <= clientWidth) return scrollLeft; // not clipped — no work
  const left = chipLeft;
  const right = left + chipWidth;
  const viewLeft = scrollLeft;
  const viewRight = viewLeft + clientWidth;
  if (left < viewLeft + pad) return Math.max(0, left - pad);
  if (right > viewRight - pad) return right - clientWidth + pad;
  return scrollLeft;
}

const ROW = { clientWidth: 815, scrollWidth: 2225 };

describe('active-chip scrolling', () => {
  it('scrolls right to reveal a chip past the fold', () => {
    // The reported case: chip ~50 of 54, far beyond the visible row.
    const next = scrollLeftFor({ chipLeft: 2000, chipWidth: 40, scrollLeft: 0, ...ROW });
    expect(next).toBeGreaterThan(0);
    // The chip must end up inside the viewport after scrolling.
    expect(2000).toBeGreaterThanOrEqual(next);
    expect(2040).toBeLessThanOrEqual(next + ROW.clientWidth);
  });

  it('scrolls left to reveal a chip before the fold', () => {
    // The regression the first implementation introduced: clicking a far-left
    // chip while scrolled right overshot and pushed it off the LEFT edge.
    const next = scrollLeftFor({ chipLeft: 40, chipWidth: 40, scrollLeft: 1410, ...ROW });
    expect(next).toBe(16); // 40 - 24 pad
    expect(next).toBeLessThanOrEqual(40);
  });

  it('never scrolls past zero', () => {
    expect(scrollLeftFor({ chipLeft: 0, chipWidth: 40, scrollLeft: 500, ...ROW })).toBe(0);
  });

  it('leaves an already-visible chip alone — no jumping while you read', () => {
    const scrollLeft = 1000;
    // Comfortably inside [1000, 1815] with padding on both sides.
    const next = scrollLeftFor({ chipLeft: 1400, chipWidth: 40, scrollLeft, ...ROW });
    expect(next).toBe(scrollLeft);
  });

  it('does nothing when the row is not clipped', () => {
    const next = scrollLeftFor({
      chipLeft: 2000,
      chipWidth: 40,
      scrollLeft: 0,
      clientWidth: 815,
      scrollWidth: 815,
    });
    expect(next).toBe(0);
  });
});

describe('TabStrip source contract', () => {
  it('measures the chip relative to the container, not via offsetLeft', () => {
    expect(SOURCE).toContain('chipRect.left - containerRect.left + container.scrollLeft');
    expect(SOURCE).not.toContain('const left = chip.offsetLeft;');
  });

  it('short-circuits when the row is not clipped', () => {
    expect(SOURCE).toContain('if (container.scrollWidth <= container.clientWidth) return;');
  });

  it('sets scrollLeft directly rather than using scrollIntoView', () => {
    // `scrollIntoView` also scrolls ancestors and can yank the whole page.
    // Match a CALL, not the word — the effect's comment names it deliberately.
    expect(SOURCE).not.toMatch(/\.scrollIntoView\s*\(/);
    expect(SOURCE).toContain('container.scrollLeft =');
  });

  it('re-runs when the active tab, tab count, or density changes', () => {
    expect(SOURCE).toContain('[activeKey, items.length, density]');
  });
});
