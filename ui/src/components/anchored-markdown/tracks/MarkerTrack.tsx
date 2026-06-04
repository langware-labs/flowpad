import { CommentPin, type CommentMark } from '../CommentPin';
import type { AnchoredItem, AnchoredTrack } from '../types';
import { IssueChip, type IssueMark } from './IssueTrack';
import { TraceMarker, type TraceMark } from './TraceTrack';

/**
 * Unified marker payload. The `AnchoredSurface` track is generic, so a single
 * column can carry any mix of comment / issue / trace pins anchored to lines.
 * Adding a new kind: extend this union and a case in `MarkerPin` below.
 */
export type MarkerItem =
  | { kind: 'comment'; mark: CommentMark }
  | { kind: 'issue'; mark: IssueMark }
  | { kind: 'trace'; mark: TraceMark };

export const MARKER_TRACK_WIDTH = 28;

export interface MarkerTrackOptions {
  id?: string;
  side?: 'left' | 'right';
  width?: number;
}

export function buildMarkerTrack(
  items: AnchoredItem<MarkerItem>[],
  opts: MarkerTrackOptions = {},
): AnchoredTrack<MarkerItem> {
  return {
    id: opts.id ?? 'markers',
    side: opts.side ?? 'right',
    width: opts.width ?? MARKER_TRACK_WIDTH,
    items,
    renderItem: (item) => <MarkerPin item={item.data} />,
  };
}

function MarkerPin({ item }: { item: MarkerItem }) {
  switch (item.kind) {
    case 'comment':
      return <CommentPin mark={item.mark} />;
    case 'issue':
      return <IssueChip issue={item.mark} />;
    case 'trace':
      return <TraceMarker mark={item.mark} />;
  }
}
