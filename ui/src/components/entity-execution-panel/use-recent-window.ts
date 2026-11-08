import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/** Rows mounted at a time, and how many more each approach to the top adds. */
export const RECENT_WINDOW = 40;

function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p);
    if (overflowY === 'auto' || overflowY === 'scroll') return p;
  }
  return null;
}

/**
 * Where a long chat starts rendering: the last {@link RECENT_WINDOW} rows, plus older ones in
 * batches as the reader scrolls toward the top. Opening a 379-message chat mounted every row
 * (and parsed every message's markdown) to show the last screenful.
 *
 * `start` never moves forward, so rows a live turn appends never unmount the ones above them,
 * and `keep` (a row a pane scrolls to) is always inside the window. Adding a batch keeps the
 * first row on screen where it was, so the reader's place doesn't jump.
 */
export function useRecentWindow(count: number, keep: number) {
  const [expanded, setExpanded] = useState<number | null>(null);
  const initial = useRef<number | null>(null);
  if (initial.current === null && count > 0) initial.current = Math.max(0, count - RECENT_WINDOW);
  const start = Math.max(0, Math.min(expanded ?? initial.current ?? 0, keep >= 0 ? keep : count));

  const sentinel = useRef<HTMLDivElement>(null);
  const pinned = useRef<{ el: Element; top: number } | null>(null);

  useLayoutEffect(() => {
    const p = pinned.current;
    if (!p) return;
    pinned.current = null;
    const scroller = scrollParent(sentinel.current ?? (p.el as HTMLElement));
    if (scroller) scroller.scrollTop += p.el.getBoundingClientRect().top - p.top;
  }, [start]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el || start === 0) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        // A parked pane (another layout is showing) reads scrollTop 0 until it is shown again: nothing
        // is near its top, and widening it there would overwrite the place the browser restores.
        if (!entry?.isIntersecting || !entry.rootBounds?.height) return;
        if (el.checkVisibility?.({ visibilityProperty: true }) === false) return;
        const first = el.nextElementSibling;
        if (first) pinned.current = { el: first, top: first.getBoundingClientRect().top };
        setExpanded(Math.max(0, start - RECENT_WINDOW));
      },
      { root: scrollParent(el), rootMargin: '800px 0px 0px 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [start]);

  return { start, sentinel };
}
