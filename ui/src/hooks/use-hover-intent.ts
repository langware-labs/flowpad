import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEventHandler } from 'react';

/** Rail hover → the bookmarks menu opens. */
export const HOVER_OPEN_MS = 100;
/** Grace after the pointer leaves before the menu closes. Covers the trip from
 *  the rail button to the panel, and small overshoots out of either. */
export const HOVER_CLOSE_GRACE_MS = 300;

/**
 * Open/close state driven by hover: a dwell before opening, a grace period
 * before closing.
 *
 * These delays are the menu's product spec — the dwell that separates "meant to
 * open this" from "swept the pointer past it". They are not latency band-aids;
 * if one feels wrong that's a UX call, so change it deliberately.
 *
 * The point of handing back one `hoverProps` to spread (rather than each
 * element owning its own hover state) is that SEVERAL disjoint subtrees can
 * share ONE intent. The rail button and the slider panel are not DOM-nested —
 * the panel is `position: fixed` and renders as a sibling — so moving between
 * them fires the first's `pointerleave` before the second's `pointerenter`.
 * Because entering cancels a pending close, that crossing can never close the
 * menu. Two independent hover states could not express this.
 *
 * `set` is the forced escape for everything that isn't hover — click toggle,
 * Escape, outside pointer-down, close-on-navigate. It cancels any pending
 * transition, so a stale timer can't reopen what a click just closed.
 */
export function useHoverIntent({ openMs, closeMs }: { openMs: number; closeMs: number }): {
  open: boolean;
  hoverProps: { onPointerEnter: PointerEventHandler; onPointerLeave: PointerEventHandler };
  set: (open: boolean) => void;
} {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  // At most one pending transition: every entry point cancels before arming.
  const schedule = useCallback((next: boolean, delay: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(next), delay);
  }, []);

  // Memoized because callers pass it as an effect dep; hoverProps is a fresh
  // object each render anyway, so memoizing the handlers would buy nothing.
  const set = useCallback(
    (next: boolean) => {
      clearTimeout(timer.current);
      setOpen(next);
    },
    [],
  );

  useEffect(() => () => clearTimeout(timer.current), []);

  return {
    open,
    hoverProps: {
      // Mouse only. Touch synthesizes pointerenter on tap, so without this a
      // tap would hover-open AND click-toggle — opening then closing again.
      onPointerEnter: (e) => e.pointerType === 'mouse' && schedule(true, openMs),
      onPointerLeave: (e) => e.pointerType === 'mouse' && schedule(false, closeMs),
    },
    set,
  };
}
