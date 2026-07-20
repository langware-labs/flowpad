import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, PointerEventHandler } from 'react';

/**
 * How long the pointer must be STATIONARY over the trigger before the surface
 * opens — resting is intent, passing through is not. An entry-based delay fires
 * while you are merely crossing a rail of icons to reach something else, which
 * is the flicker NN/g's mega-menu guidance exists to prevent.
 * https://www.nngroup.com/articles/mega-menus-work-well/
 */
export const HOVER_DWELL_MS = 500;
/** Grace after the pointer leaves BOTH the trigger and the surface, per the same
 *  guidance ("keep showing it until the pointer has been outside both … for 0.5
 *  seconds"). Also covers the trip from the trigger across to the panel. */
export const HOVER_CLOSE_GRACE_MS = 500;

/**
 * Open/close state driven by hover intent: open once the pointer RESTS on the
 * trigger, close a grace period after it leaves.
 *
 * Spread one `hoverProps` onto every subtree that should hold the surface open.
 * That is what lets disjoint subtrees share a single intent — a rail button and
 * a `position: fixed` panel are not DOM-nested, so moving between them fires the
 * first's pointerleave before the second's pointerenter. Entering cancels the
 * pending close, so the crossing can never dismiss.
 *
 * `set` is the forced escape for everything that isn't hover — click, Escape,
 * outside pointer-down, close-on-navigate. It cancels any pending transition, so
 * a stale timer can't reopen what a click just closed.
 */
export function useHoverIntent({
  dwellMs = HOVER_DWELL_MS,
  closeMs = HOVER_CLOSE_GRACE_MS,
}: { dwellMs?: number; closeMs?: number } = {}): {
  open: boolean;
  hoverProps: {
    onPointerEnter: PointerEventHandler;
    onPointerMove: PointerEventHandler;
    onPointerLeave: PointerEventHandler;
  };
  set: (open: boolean) => void;
} {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  const schedule = useCallback((next: boolean, delay: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(next), delay);
  }, []);

  // Memoized because callers pass it as an effect dep; hoverProps is a fresh
  // object each render anyway, so memoizing the handlers would buy nothing.
  const set = useCallback((next: boolean) => {
    clearTimeout(timer.current);
    setOpen(next);
  }, []);

  useEffect(() => () => clearTimeout(timer.current), []);

  // Mouse only. Touch synthesizes pointerenter on tap, so without this a tap
  // would hover-open AND click-toggle — opening then closing again.
  const mouse = (e: ReactPointerEvent) => e.pointerType === 'mouse';

  return {
    open,
    hoverProps: {
      onPointerEnter: (e) => mouse(e) && schedule(true, dwellMs),
      // Every move restarts the dwell. Trigger-only: an open panel's moves are
      // guarded out, and a closed one can't be hovered.
      onPointerMove: (e) => mouse(e) && !open && schedule(true, dwellMs),
      onPointerLeave: (e) => mouse(e) && schedule(false, closeMs),
    },
    set,
  };
}
