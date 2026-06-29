import { cn } from '@src/lib/utils';
import { SeverityTier } from '@sdk/models/severity';

import type { StepHistory } from '../../data/types';

/**
 * Tiny inline SVG showing one step's history across runs.
 *
 * Each point is a colored bar; height encodes duration_ms (relative to the
 * series max), color encodes status: error=red, retry=amber, info=neutral,
 * clean=emerald. The currently-displayed run (rightmost point) is bolded.
 *
 * No business logic — receives a `StepHistory` and renders.
 */

interface StepSparklineProps {
  history?: StepHistory;
  /** When 1 we draw a bigger active bar; when overlaying multiple runs we draw thinner bars. */
  density?: 'normal' | 'dense';
}

const COLOR_BY_STATUS: Record<string, string> = {
  error: 'fill-destructive',
  retried: 'fill-amber-500',
  skip: 'fill-muted-foreground/50',
  incomplete: 'fill-muted-foreground/40',
  done: 'fill-emerald-500',
};

function colorFor(point: StepHistory['points'][number]): string {
  if (point.worstTier === SeverityTier.ATTENTION) return 'fill-destructive';
  return COLOR_BY_STATUS[point.status] ?? 'fill-muted-foreground/40';
}

export function StepSparkline({ history, density = 'normal' }: StepSparklineProps) {
  if (!history || history.points.length === 0) {
    return (
      <span
        data-testid="step-sparkline"
        data-points="0"
        className="inline-block h-3 w-12 opacity-30"
        aria-hidden
      />
    );
  }
  const points = history.points;
  const maxMs = Math.max(1, ...points.map((p) => p.duration_ms ?? 0));
  const w = density === 'dense' ? 4 : 6;
  const gap = density === 'dense' ? 1 : 1.5;
  const h = 12;
  const width = points.length * w + (points.length - 1) * gap;
  return (
    <svg
      data-testid="step-sparkline"
      data-points={points.length}
      width={width}
      height={h}
      viewBox={`0 0 ${width} ${h}`}
      className="inline-block align-middle"
      aria-hidden
    >
      {points.map((p, i) => {
        const x = i * (w + gap);
        const ratio = (p.duration_ms ?? 0) / maxMs;
        const barH = Math.max(2, Math.round(ratio * (h - 2)));
        const y = h - barH;
        const isActive = i === points.length - 1;
        return (
          <rect
            key={p.processId + ':' + i}
            x={x}
            y={y}
            width={w}
            height={barH}
            rx={1}
            className={cn(colorFor(p), !isActive && 'opacity-60')}
          />
        );
      })}
    </svg>
  );
}
