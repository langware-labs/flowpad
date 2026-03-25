import type { StreamMetrics } from '../scroll/StreamMetrics.js';

const COL_WIDTH  = 18;
const DOT_SIZE   = 8;
const TRACK_COLOR   = '#1e2530';
const DOT_COLOR     = '#58a6ff';
const DOT_COLOR_TIME = '#f0a050';

interface Props {
  metrics: StreamMetrics;
  /** 'buffer' = position in row space; 'time' = position in timestamp space */
  mode: 'buffer' | 'time';
  /** 'time' mode inner track is 2× the viewport height (shows finer time resolution) */
}

/**
 * Thin scroll-indicator column.
 *
 * - mode='buffer': dot tracks the viewport's position in the total buffer row count.
 *   Height = viewportPixelHeight. Primary sync key: buffer row fraction.
 *
 * - mode='time': dot tracks the viewport's center in the stream's time range.
 *   Container height = viewportPixelHeight, inner track = 2× (overflow hidden).
 *   The inner track scrolls so the dot is always visible.
 *   Primary sync key: timestamp.
 */
export function ScrollPointerCol({ metrics, mode }: Props) {
  const { viewportPixelHeight, scrollFraction, timeFraction } = metrics;

  const fraction  = mode === 'buffer' ? scrollFraction : timeFraction;
  const dotColor  = mode === 'buffer' ? DOT_COLOR : DOT_COLOR_TIME;
  const trackH    = mode === 'time' ? viewportPixelHeight * 2 : viewportPixelHeight;

  // For 2× time mode: shift the track so the dot is centered in the container
  const dotYInTrack = fraction * (trackH - DOT_SIZE);
  const trackOffset = mode === 'time'
    ? -Math.max(0, dotYInTrack - viewportPixelHeight / 2 + DOT_SIZE / 2)
    : 0;

  const fractionStr = fraction.toFixed(3);
  const testId      = mode === 'buffer' ? 'scroll-pointer-col' : 'time-scale-col';
  const dotTestId   = mode === 'buffer' ? 'scroll-dot' : 'time-dot';
  const dataAttr    = mode === 'buffer'
    ? { 'data-scroll-fraction': fractionStr }
    : { 'data-time-fraction':   fractionStr };

  return (
    <div
      data-testid={testId}
      style={{
        width:    COL_WIDTH,
        height:   viewportPixelHeight,
        flexShrink: 0,
        background: TRACK_COLOR,
        borderRadius: 4,
        overflow: 'hidden',
        position: 'relative',
        cursor:   'default',
      }}
      {...dataAttr}
    >
      {/* Inner track (2× height for time mode) */}
      <div style={{
        position: 'absolute',
        top: trackOffset,
        left: 0,
        width:  '100%',
        height: trackH,
      }}>
        {/* Dot */}
        <div
          data-testid={dotTestId}
          style={{
            position:    'absolute',
            top:         dotYInTrack,
            left:        '50%',
            transform:   'translateX(-50%)',
            width:       DOT_SIZE,
            height:      DOT_SIZE,
            borderRadius: '50%',
            background:  dotColor,
            boxShadow:   `0 0 4px ${dotColor}88`,
          }}
        />
      </div>
    </div>
  );
}
