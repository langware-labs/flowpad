import { cn } from '@src/lib/utils';

import { LineAnchorProviderCtx, useAnchorVersion, useLineAnchorProvider } from './LineAnchorContext';
import type { AnchoredTrack, LineAnchorProvider } from './types';

interface AnchoredSurfaceProps {
  provider: LineAnchorProvider;
  // `AnchoredTrack<any>[]` so callers can mix tracks with different item-payload
  // types (e.g. StatusTrack<StepViewModel> + AttentionTrack<StackPayload> +
  // unified MarkerTrack<MarkerItem>). The default `AnchoredTrack<unknown>[]`
  // is too narrow for typed tracks because `renderItem` is contravariant.
  leftTracks?: AnchoredTrack<any>[];
  rightTracks?: AnchoredTrack<any>[];
  /** The body content (markdown, editor, etc.) — rendered in the middle column. */
  children: React.ReactNode;
  className?: string;
}

/**
 * AnchoredSurface — three-column flex layout.
 *
 *   ┌── left tracks ──┬─── body ───┬── right tracks ──┐
 *   │ absolute items  │ children   │ absolute items   │
 *   └─────────────────┴────────────┴──────────────────┘
 *
 * The body's height is the natural height of the `children`. Track columns
 * stretch to match (align-items: stretch). Inside each track column,
 * `position: relative` anchors absolutely-positioned markers at
 * `top = provider.getRect(line).top`. Because all three columns are flex
 * siblings in the same row, their Y origins coincide, so the body's
 * data-line `offsetTop` aligns directly with track-column markers without
 * any cross-frame translation.
 */
export function AnchoredSurface({ provider, leftTracks = [], rightTracks = [], children, className }: AnchoredSurfaceProps) {
  return (
    <LineAnchorProviderCtx.Provider value={provider}>
      <div className={cn('flex flex-row items-stretch', className)} data-testid="anchored-surface">
        {leftTracks.map((t) => (
          <TrackColumn key={t.id} track={t} />
        ))}
        <div className="min-w-0 flex-1">{children}</div>
        {rightTracks.map((t) => (
          <TrackColumn key={t.id} track={t} />
        ))}
      </div>
    </LineAnchorProviderCtx.Provider>
  );
}

function TrackColumn({ track }: { track: AnchoredTrack }) {
  const provider = useLineAnchorProvider();
  // Re-render whenever the provider notifies a layout change.
  useAnchorVersion(provider);

  // Group items by source line so duplicates stack vertically instead of
  // overlapping at the same `top`.
  const grouped = groupByLine(track.items);

  return (
    <aside
      className={cn(
        'relative flex-shrink-0',
        track.side === 'left' ? 'border-r border-border/40' : 'border-l border-border/40',
      )}
      style={{ width: track.width }}
      data-testid={`anchored-track-${track.id}`}
      data-side={track.side}
    >
      {provider &&
        Array.from(grouped.entries()).map(([line, items]) => {
          const rect = provider.getRect(line);
          if (!rect) return null;
          return (
            <div
              key={line}
              className="absolute left-0 right-0 flex flex-col gap-0.5 px-0.5 py-0.5"
              style={{ top: rect.top, minHeight: rect.height }}
              data-line={line}
              data-track={track.id}
              data-item-count={items.length}
            >
              {items.map((item) => (
                <div key={item.id}>{track.renderItem(item)}</div>
              ))}
            </div>
          );
        })}
    </aside>
  );
}

function groupByLine<T>(items: AnchoredTrack<T>['items']): Map<number, AnchoredTrack<T>['items']> {
  const out = new Map<number, AnchoredTrack<T>['items']>();
  for (const item of items) {
    const arr = out.get(item.anchor.line);
    if (arr) arr.push(item);
    else out.set(item.anchor.line, [item]);
  }
  return out;
}
