import type { StreamMetrics } from '../scroll/StreamMetrics.js';
import type { IXtermAdapter } from '../adapter/XtermAdapter.js';

const SLOTS     = 100;
const COL_WIDTH = 18;

interface Props {
  metrics: StreamMetrics;
  adapter: IXtermAdapter;
}

/**
 * Time-scale column — 100 equal-duration slots spanning [minTimestamp, maxTimestamp].
 *
 * - Slots that contain at least one packet are lit amber.
 * - The slot corresponding to the current viewport's center time is highlighted.
 * - Clicking any slot finds the real packet whose timestamp is closest to that
 *   slot's midpoint, then scrolls the terminal to that packet's buffer row.
 */
export function TimeScaleCol({ metrics, adapter }: Props) {
  const {
    viewportPixelHeight, timeFraction,
    minTimestamp, maxTimestamp, coords,
  } = metrics;

  const timeRange   = maxTimestamp - minTimestamp;
  const currentSlot = Math.min(SLOTS - 1, Math.round(timeFraction * (SLOTS - 1)));

  // Which slots have at least one packet?
  const activeSlots = new Set<number>();
  if (timeRange > 0) {
    for (const c of coords) {
      const idx = Math.floor(((c.timestamp - minTimestamp) / timeRange) * (SLOTS - 1));
      activeSlots.add(Math.max(0, Math.min(SLOTS - 1, idx)));
    }
  } else if (coords.length > 0) {
    // single-event degenerate case: all packets map to slot 0
    activeSlots.add(0);
  }

  function handleClick(e: React.MouseEvent<HTMLDivElement>) {
    if (coords.length === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));

    let targetTime: number;
    if (timeRange <= 0) {
      targetTime = minTimestamp;
    } else {
      // Quantise to the nearest slot midpoint, then convert back to timestamp
      const slot = Math.round(fraction * (SLOTS - 1));
      targetTime = minTimestamp + (slot / (SLOTS - 1)) * timeRange;
    }

    // Find the coord with the closest timestamp to targetTime
    let best = coords[0];
    let bestDist = Math.abs(coords[0].timestamp - targetTime);
    for (const c of coords) {
      const dist = Math.abs(c.timestamp - targetTime);
      if (dist < bestDist) { bestDist = dist; best = c; }
    }

    adapter.scrollToRow(best.bufferRow);
  }

  return (
    <div
      data-testid="time-scale-col"
      data-time-fraction={timeFraction.toFixed(3)}
      title={
        timeRange > 0
          ? `Time scale — ${SLOTS} slots · click to jump to nearest packet · range ${timeRange.toFixed(0)} ms`
          : 'Time scale (single event)'
      }
      style={{
        width:      COL_WIDTH,
        height:     viewportPixelHeight,
        flexShrink: 0,
        display:    'flex',
        flexDirection: 'column',
        borderRadius: 4,
        overflow:   'hidden',
        cursor:     coords.length > 0 ? 'pointer' : 'default',
      }}
      onClick={handleClick}
    >
      {Array.from({ length: SLOTS }, (_, i) => {
        const isActive  = activeSlots.has(i);
        const isCurrent = i === currentSlot;

        let bg: string;
        if (isCurrent && isActive) bg = '#f0a050';          // current + has packet
        else if (isCurrent)        bg = '#c07830';          // current, no packet
        else if (isActive)         bg = '#3a3010';          // has packet
        else                       bg = '#1a2030';          // empty

        return (
          <div
            key={i}
            data-testid={isCurrent ? 'time-dot' : undefined}
            style={{
              flex:       1,
              background: bg,
              // Major tick every 10 slots
              borderBottom: (i + 1) % 10 === 0 && i < SLOTS - 1
                ? '1px solid #2a3848'
                : undefined,
            }}
          />
        );
      })}
    </div>
  );
}
