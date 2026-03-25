import { useRef } from 'react';
import type { StreamMetrics } from '../scroll/StreamMetrics.js';
import type { IXtermAdapter } from '../adapter/XtermAdapter.js';

const WIDTH = 8;

interface Props {
  metrics: StreamMetrics;
  adapter: IXtermAdapter;
}

/**
 * Custom scrollbar for xterm — replaces the native viewport scrollbar, which
 * is permanently covered by .xterm-screen and therefore unclickable.
 *
 * Renders a thin track next to the terminal. The thumb position mirrors
 * StreamMetrics.scrollFraction. Dragging the thumb (or clicking the track)
 * calls adapter.scrollToFraction(), which sets .xterm-viewport.scrollTop
 * directly, triggering xterm's native scroll handling.
 */
export function XtermScrollbar({ metrics, adapter }: Props) {
  const { viewportPixelHeight, scrollFraction, visibleRows, totalBufferRows } = metrics;

  // Clamp thumb to at least 20px, proportional to visible/total ratio
  const ratio   = totalBufferRows > 0 ? Math.max(0.04, visibleRows / totalBufferRows) : 1;
  const thumbH  = Math.max(20, ratio * viewportPixelHeight);
  const trackH  = viewportPixelHeight - thumbH;
  const thumbTop = scrollFraction * trackH;

  // Drag state — all in a ref to avoid re-renders during drag
  const drag = useRef<{ startY: number; startFraction: number; trackH: number } | null>(null);

  function handleThumbDown(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    drag.current = { startY: e.clientY, startFraction: scrollFraction, trackH };

    function onMove(ev: MouseEvent) {
      if (!drag.current) return;
      const dy  = ev.clientY - drag.current.startY;
      const f   = drag.current.startFraction + dy / drag.current.trackH;
      adapter.scrollToFraction(f);
    }
    function onUp() {
      drag.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup',   onUp);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',   onUp);
  }

  function handleTrackClick(e: React.MouseEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const y    = e.clientY - rect.top;
    adapter.scrollToFraction(y / viewportPixelHeight);
  }

  const canScroll = totalBufferRows > visibleRows;

  return (
    <div
      data-testid="xterm-scrollbar"
      onClick={canScroll ? handleTrackClick : undefined}
      style={{
        width:        WIDTH,
        height:       viewportPixelHeight,
        flexShrink:   0,
        position:     'relative',
        background:   'rgba(255,255,255,0.04)',
        borderRadius: 4,
        cursor:       canScroll ? 'pointer' : 'default',
      }}
    >
      {canScroll && (
        <div
          data-testid="xterm-scrollbar-thumb"
          onMouseDown={handleThumbDown}
          onClick={e => e.stopPropagation()}
          style={{
            position:     'absolute',
            left:         1,
            width:        WIDTH - 2,
            top:          thumbTop,
            height:       thumbH,
            background:   'rgba(255,255,255,0.22)',
            borderRadius: 3,
            cursor:       'grab',
          }}
        />
      )}
    </div>
  );
}
