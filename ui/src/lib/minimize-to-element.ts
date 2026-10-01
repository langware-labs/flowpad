/**
 * "Genie-minimize" — visually fly a source element into a small target
 * (e.g. a dialog collapsing into the footer's active-process chip), telling
 * the user the work now lives behind that target.
 *
 * The source is cloned into a fixed-position ghost on `document.body`, so the
 * real element can unmount immediately (close the dialog, don't wait). The
 * ghost shrinks/translates onto the target's center and fades, then the target
 * gets a one-shot glow so the eye lands on where the process went.
 *
 * Fire-and-forget and purely cosmetic: no target, a hidden source, or a
 * reduced-motion preference all degrade to doing nothing.
 */

import { animateGlow } from './animate-glow';

// Dedicated runtime anchors (not test ids — those may be renamed freely by
// test refactors without anyone noticing the animation silently degrading).
const PENDING_CHIP_SELECTOR = '[data-minimize-anchor="process-chip"]';
const FOOTER_SELECTOR = '[data-minimize-anchor="footer"]';

/** The flight's timing, shared with maximize-from (the same flight played backwards). */
export const GENIE_DURATION_MS = 450;
export const GENIE_EASING = 'cubic-bezier(0.4, 0, 0.2, 1)';
/** Opacity at the small end. Never 0: an invisible ghost is a fade, not a flight. */
export const GENIE_SMALL_OPACITY = 0.2;

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The transform that lays an element sitting at `box` over `onto`: centers
 * matched, scaled to fit INSIDE `onto` (min ratio, never enlarged — a
 * wide-but-short target like the footer must still shrink it, not inflate it).
 *
 * Minimize animates identity → this; maximize-from (a window zooming out of
 * the icon that opened it) animates this → identity.
 */
export function genieTransform(box: Box, onto: Box): string {
  const dx = onto.left + onto.width / 2 - (box.left + box.width / 2);
  const dy = onto.top + onto.height / 2 - (box.top + box.height / 2);
  const scale = Math.min(
    Math.max(Math.min(onto.width / Math.max(1, box.width), onto.height / Math.max(1, box.height)), 0.04),
    1,
  );
  return `translate(${dx}px, ${dy}px) scale(${scale})`;
}

export function animateMinimizeToElement(
  source: HTMLElement | null,
  target: HTMLElement | null,
): void {
  if (!source || !target || typeof source.animate !== 'function') return;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

  const from = source.getBoundingClientRect();
  const to = target.getBoundingClientRect();
  if (from.width === 0 || from.height === 0 || to.width === 0) return;

  const ghost = source.cloneNode(true) as HTMLElement;
  Object.assign(ghost.style, {
    position: 'fixed',
    top: `${from.top}px`,
    left: `${from.left}px`,
    width: `${from.width}px`,
    height: `${from.height}px`,
    margin: '0',
    // Above the dialog overlay (z-50) so the flight isn't dimmed by it.
    zIndex: '100',
    pointerEvents: 'none',
    overflow: 'hidden',
    transform: 'none',
    transformOrigin: 'center center',
  });
  document.body.appendChild(ghost);
  // Hide the source so its own exit animation doesn't double-image with the
  // flight; the caller closes it right after, so it's about to unmount anyway.
  source.style.visibility = 'hidden';

  const flight = ghost.animate(
    [
      { transform: 'translate(0, 0) scale(1)', opacity: 1 },
      { transform: genieTransform(from, to), opacity: GENIE_SMALL_OPACITY },
    ],
    { duration: GENIE_DURATION_MS, easing: GENIE_EASING },
  );
  const cleanup = () => ghost.remove();
  flight.oncancel = cleanup;
  flight.onfinish = () => {
    cleanup();
    animateGlow(target);
  };
}

/**
 * Minimize `source` into the footer's active-process chip. Falls back to the
 * footer itself when the chip isn't rendered (no live workers yet).
 */
export function animateMinimizeToProcessChip(source: HTMLElement | null): void {
  const target =
    document.querySelector<HTMLElement>(PENDING_CHIP_SELECTOR) ??
    document.querySelector<HTMLElement>(FOOTER_SELECTOR);
  animateMinimizeToElement(source, target);
}
