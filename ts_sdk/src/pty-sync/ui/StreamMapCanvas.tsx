import { useEffect, useRef, useCallback } from 'react';
import type { IXtermAdapter } from '../adapter/XtermAdapter.js';
import type { StreamMetrics } from '../scroll/StreamMetrics.js';

const CANVAS_WIDTH  = 28;
const DOT_RADIUS    = 3;
const COMMENT_SIZE  = 6;

const COLOR_BG            = '#0d1117';
const COLOR_VIEWPORT      = '#58a6ff33';
const COLOR_VIEWPORT_LINE = '#58a6ff';
const COLOR_DOT           = '#58a6ff';
const COLOR_COMMENT_SQ    = '#f0a050';
const COLOR_HOVER_LINE    = 'rgba(255,255,255,0.25)';
const COLOR_HOVER_DOT     = '#ffffff';

function coordToCanvasY(timestamp: number, minTimestamp: number, timeRange: number, H: number): number {
  return timeRange > 0
    ? ((timestamp - minTimestamp) / timeRange) * (H - DOT_RADIUS * 2) + DOT_RADIUS
    : H / 2;
}

interface Props {
  metrics: StreamMetrics;
  adapter: IXtermAdapter;
  /** Map<bufferRow, commentText> */
  comments: Map<number, string>;
}

/**
 * Canvas scroll-position map of the full stream.
 *
 * - Height = viewportPixelHeight (same as xterm viewport).
 * - Each packet = a dot, y-positioned by timestamp fraction in the stream time range.
 * - Comment squares drawn over dots (take UX priority).
 * - Horizontal bar = current viewport scroll position.
 * - Click on a dot → adapter.scrollToRow(bufferRow).
 * - Mouse hover: horizontal scrub line + nearest-dot highlight.
 */
export function StreamMapCanvas({ metrics, adapter, comments }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hoverYRef = useRef<number | null>(null);
  const rafRef    = useRef<number | null>(null);

  const { viewportPixelHeight, coords, scrollFraction, minTimestamp, maxTimestamp } = metrics;
  const timeRange = maxTimestamp - minTimestamp;

  // ── Core draw (called from effect and mouse handlers) ────────────────────────
  const drawAll = useCallback((hoverY: number | null) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = CANVAS_WIDTH;
    const H = viewportPixelHeight;
    canvas.width  = W;
    canvas.height = H;

    // Background
    ctx.fillStyle = COLOR_BG;
    ctx.fillRect(0, 0, W, H);

    // Viewport band
    const vpH = timeRange > 0
      ? (metrics.visibleRows / Math.max(1, metrics.totalBufferRows)) * H
      : H;
    const vpY = scrollFraction * (H - vpH);
    ctx.fillStyle = COLOR_VIEWPORT;
    ctx.fillRect(0, vpY, W, vpH);
    ctx.strokeStyle = COLOR_VIEWPORT_LINE;
    ctx.lineWidth = 1;
    ctx.strokeRect(0, vpY, W, vpH);

    // Find nearest coord to hover position (for highlight)
    let nearestCoord = coords.length > 0 ? coords[0] : null;
    if (hoverY !== null && coords.length > 0) {
      let bestDist = Infinity;
      for (const c of coords) {
        const dist = Math.abs(coordToCanvasY(c.timestamp, minTimestamp, timeRange, H) - hoverY);
        if (dist < bestDist) { bestDist = dist; nearestCoord = c; }
      }
    }

    // Packet dots
    for (const c of coords) {
      const y = coordToCanvasY(c.timestamp, minTimestamp, timeRange, H);
      const hasComment  = comments.has(c.bufferRow);
      const isHighlight = hoverY !== null && nearestCoord === c;

      if (hasComment) {
        const sz = isHighlight ? COMMENT_SIZE + 3 : COMMENT_SIZE;
        ctx.fillStyle = isHighlight ? '#ffc870' : COLOR_COMMENT_SQ;
        ctx.fillRect(W / 2 - sz / 2, y - sz / 2, sz, sz);
      } else {
        const r = isHighlight ? DOT_RADIUS + 2 : DOT_RADIUS;
        ctx.beginPath();
        ctx.arc(W / 2, y, r, 0, Math.PI * 2);
        ctx.fillStyle = isHighlight ? COLOR_HOVER_DOT : COLOR_DOT;
        if (isHighlight) {
          ctx.shadowColor = COLOR_HOVER_DOT;
          ctx.shadowBlur  = 6;
        }
        ctx.fill();
        ctx.shadowBlur = 0;
      }
    }

    // Hover scrub line (drawn on top of dots)
    if (hoverY !== null) {
      ctx.strokeStyle = COLOR_HOVER_LINE;
      ctx.lineWidth   = 1;
      ctx.beginPath();
      ctx.moveTo(0, hoverY);
      ctx.lineTo(W, hoverY);
      ctx.stroke();
    }
  }, [metrics, comments, viewportPixelHeight, timeRange, scrollFraction,
      coords, minTimestamp]);

  // ── Redraw on data change ────────────────────────────────────────────────────
  useEffect(() => {
    drawAll(hoverYRef.current);
  }, [drawAll]);

  // ── Mouse handlers (no React state — RAF-throttled canvas writes) ────────────
  function scheduleRedraw() {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      drawAll(hoverYRef.current);
    });
  }

  function handleMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    hoverYRef.current = e.clientY - rect.top;
    scheduleRedraw();
  }

  function handleMouseLeave() {
    hoverYRef.current = null;
    scheduleRedraw();
  }

  // ── Click → scroll ─────────────────────────────────────────────────────────
  function handleClick(e: React.MouseEvent<HTMLCanvasElement>) {
    if (coords.length === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const clickY = e.clientY - rect.top;
    const H = viewportPixelHeight;

    let best = coords[0];
    let bestDist = Infinity;
    for (const c of coords) {
      const dist = Math.abs(coordToCanvasY(c.timestamp, minTimestamp, timeRange, H) - clickY);
      if (dist < bestDist) { bestDist = dist; best = c; }
    }

    adapter.scrollToRow(best.bufferRow);
  }

  return (
    <canvas
      ref={canvasRef}
      data-testid="stream-map-canvas"
      width={CANVAS_WIDTH}
      height={viewportPixelHeight}
      style={{
        width:     CANVAS_WIDTH,
        height:    viewportPixelHeight,
        flexShrink: 0,
        cursor:    coords.length > 0 ? 'crosshair' : 'default',
        borderRadius: 4,
        display:   'block',
      }}
      onClick={handleClick}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      title="Hover to scrub · click to scroll to nearest packet"
    />
  );
}
