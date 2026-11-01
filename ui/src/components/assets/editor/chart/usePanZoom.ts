import { useCallback, useEffect, useRef, useState } from 'react';

interface View {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Canvas-style zoom and pan for an SVG chart, on its viewBox: the wheel zooms at the cursor, a drag
 * pans, `fit()` shows the whole chart. A drag never counts as a click on what it started on.
 */
export function usePanZoom(width: number, height: number) {
  // A callback ref: the svg remounts (Table ↔ Diagram), and each one needs its own wheel listener.
  const [svgEl, setSvgEl] = useState<SVGSVGElement | null>(null);
  const elRef = useRef<SVGSVGElement | null>(null);
  elRef.current = svgEl;
  const [view, setView] = useState<View>({ x: 0, y: 0, w: width, h: height });
  const viewRef = useRef(view);
  viewRef.current = view;
  const drag = useRef<{ x: number; y: number; view: View; moved: boolean } | null>(null);
  const suppressClick = useRef(false);

  const fit = useCallback(() => setView({ x: 0, y: 0, w: width, h: height }), [width, height]);
  useEffect(fit, [fit]);

  /** Screen px → chart units: with `meet`, the larger of the two ratios. */
  const unitsPerPx = useCallback(() => {
    const el = elRef.current;
    const v = viewRef.current;
    if (!el || !el.clientWidth || !el.clientHeight) return 1;
    return Math.max(v.w / el.clientWidth, v.h / el.clientHeight);
  }, []);

  const zoomAt = useCallback(
    (factor: number, clientX?: number, clientY?: number) => {
      const el = elRef.current;
      setView((v) => {
        const w = Math.min(width * 4, Math.max(width / 12, v.w * factor));
        const h = (w / v.w) * v.h;
        // The point under the cursor stays put; without a cursor, the centre does.
        let fx = 0.5;
        let fy = 0.5;
        if (el && clientX !== undefined && clientY !== undefined) {
          const r = el.getBoundingClientRect();
          const k = Math.max(v.w / r.width, v.h / r.height);
          const ox = (r.width * k - v.w) / 2;
          const oy = (r.height * k - v.h) / 2;
          fx = ((clientX - r.left) * k - ox) / v.w;
          fy = ((clientY - r.top) * k - oy) / v.h;
        }
        return { x: v.x + (v.w - w) * fx, y: v.y + (v.h - h) * fy, w, h };
      });
    },
    [width],
  );

  // A native, non-passive wheel listener: React's onWheel cannot stop the page from scrolling.
  useEffect(() => {
    const el = svgEl;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomAt(Math.exp(e.deltaY * 0.0015), e.clientX, e.clientY);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAt, svgEl]);

  const handlers = {
    onPointerDown: (e: React.PointerEvent<SVGSVGElement>) => {
      if (e.button !== 0) return;
      drag.current = { x: e.clientX, y: e.clientY, view: viewRef.current, moved: false };
    },
    onPointerMove: (e: React.PointerEvent<SVGSVGElement>) => {
      const d = drag.current;
      if (!d) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) < 4) return;
      if (!d.moved) {
        d.moved = true;
        e.currentTarget.setPointerCapture?.(e.pointerId);
      }
      const k = unitsPerPx();
      setView({ ...d.view, x: d.view.x - dx * k, y: d.view.y - dy * k });
    },
    onPointerUp: () => {
      suppressClick.current = !!drag.current?.moved;
      drag.current = null;
    },
    onClickCapture: (e: React.MouseEvent) => {
      if (suppressClick.current) {
        suppressClick.current = false;
        e.stopPropagation();
      }
    },
  };

  const zoomed = Math.abs(view.w - width) > 1 || Math.abs(view.x) > 1 || Math.abs(view.y) > 1;
  return {
    svgRef: setSvgEl,
    viewBox: `${view.x} ${view.y} ${view.w} ${view.h}`,
    handlers,
    fit,
    zoomIn: () => zoomAt(1 / 1.25),
    zoomOut: () => zoomAt(1.25),
    zoomed,
  };
}
