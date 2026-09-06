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

  const dx = to.left + to.width / 2 - (from.left + from.width / 2);
  const dy = to.top + to.height / 2 - (from.top + from.height / 2);
  // Fit INSIDE the target: min ratio, never enlarged. A wide-but-short target
  // (the footer fallback) must still shrink the ghost, not inflate it.
  const scale = Math.min(
    Math.max(Math.min(to.width / from.width, to.height / from.height), 0.04),
    1,
  );

  const flight = ghost.animate(
    [
      { transform: 'translate(0, 0) scale(1)', opacity: 1 },
      { transform: `translate(${dx}px, ${dy}px) scale(${scale})`, opacity: 0.2 },
    ],
    { duration: 450, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' },
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
