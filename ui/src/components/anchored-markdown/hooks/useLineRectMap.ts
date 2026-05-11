import { useCallback, useEffect, useRef } from 'react';

import type { LineAnchorProvider, LineRect } from '../types';

/**
 * useLineRectMap — given a containerRef, builds a Map<line, LineRect> by
 * walking [data-line] descendants. Re-builds on:
 *  - ResizeObserver entries on the container
 *  - 'load' events on Font / window
 *  - manual `bump()` calls (when the markdown source changes)
 *
 * Returns a LineAnchorProvider that tracks subscribe to.
 */
export function useLineRectMap(containerRef: React.RefObject<HTMLElement | null>): LineAnchorProvider & { bump: () => void } {
  const mapRef = useRef<Map<number, LineRect>>(new Map());
  const subsRef = useRef<Set<() => void>>(new Set());

  const recompute = useCallback(() => {
    const root = containerRef.current;
    if (!root) return;
    const next = new Map<number, LineRect>();
    const nodes = root.querySelectorAll<HTMLElement>('[data-line]');
    for (const el of nodes) {
      const raw = el.getAttribute('data-line');
      if (!raw) continue;
      const line = Number(raw);
      if (!Number.isFinite(line)) continue;
      // Don't overwrite a smaller (more specific) rect with a parent's. First
      // wins is correct here because react-markdown emits leaves before parents
      // in some rehype paths; using `has` keeps the closest annotated element.
      if (!next.has(line)) {
        next.set(line, { top: el.offsetTop, height: el.offsetHeight });
      }
    }
    mapRef.current = next;
    for (const cb of subsRef.current) cb();
  }, [containerRef]);

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    recompute();
    const ro = new ResizeObserver(() => recompute());
    ro.observe(root);
    const onWin = () => recompute();
    window.addEventListener('resize', onWin);
    if (typeof document !== 'undefined' && (document as unknown as { fonts?: FontFaceSet }).fonts) {
      const fonts = (document as unknown as { fonts: FontFaceSet }).fonts;
      void fonts.ready.then(() => recompute());
    }
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', onWin);
    };
  }, [containerRef, recompute]);

  const getRect = useCallback((line: number) => mapRef.current.get(line) ?? null, []);
  const subscribe = useCallback((cb: () => void) => {
    subsRef.current.add(cb);
    return () => {
      subsRef.current.delete(cb);
    };
  }, []);

  return { getRect, subscribe, bump: recompute };
}
