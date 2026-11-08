import { useCallback, useEffect, useRef, useState } from 'react';

/** Screen px → chart units: with `meet`, the larger of the two ratios. */
const scaleOf = (v: View, size: { w: number; h: number } | null) => (size ? Math.max(v.w / size.w, v.h / size.h) : 1);

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
export function usePanZoom(width: number, height: number, { fitWidth = false }: { fitWidth?: boolean } = {}) {
  // A callback ref: the svg remounts (Table ↔ Diagram), and each one needs its own wheel listener.
  const [svgEl, setSvgEl] = useState<SVGSVGElement | null>(null);
  const elRef = useRef<SVGSVGElement | null>(null);
  elRef.current = svgEl;
  const [view, setView] = useState<View>({ x: 0, y: 0, w: width, h: height });
  // The svg's on-screen size, tracked by a ResizeObserver — never read from layout per frame.
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const sizeRef = useRef(size);
  sizeRef.current = size;
  useEffect(() => {
    if (!svgEl) return;
    const measure = () =>
      setSize(svgEl.clientWidth && svgEl.clientHeight ? { w: svgEl.clientWidth, h: svgEl.clientHeight } : null);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(svgEl);
    return () => ro.disconnect();
  }, [svgEl]);
  const viewRef = useRef(view);
  viewRef.current = view;
  const drag = useRef<{ x: number; y: number; view: View; moved: boolean } | null>(null);
  const suppressClick = useRef(false);

  // `fitWidth`: Fit = the full width, from the top — a tall chart is panned down, never shrunk until
  // its text is unreadable (a sequence chart keeps its participant cards pinned while it is).
  const fit = useCallback(() => {
    const s = sizeRef.current;
    const aspect = s ? s.h / s.w : height / width;
    setView({ x: 0, y: 0, w: width, h: fitWidth ? Math.min(height, width * aspect) : height });
  }, [width, height, fitWidth]);
  useEffect(fit, [fit, size]);

  const unitsPerPx = useCallback(() => scaleOf(viewRef.current, sizeRef.current), []);

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

  /** The chart y at the top edge of what is on screen (with `meet`, the view may be letterboxed). */
  const visibleTop = size ? view.y - (size.h * scaleOf(view, size) - view.h) / 2 : view.y;
  const zoomed = Math.abs(view.w - width) > 1 || Math.abs(view.x) > 1 || Math.abs(view.y) > 1;
  return {
    svgRef: setSvgEl,
    viewBox: `${view.x} ${view.y} ${view.w} ${view.h}`,
    handlers,
    fit,
    zoomIn: () => zoomAt(1 / 1.25),
    zoomOut: () => zoomAt(1.25),
    zoomed,
    visibleTop,
  };
}
