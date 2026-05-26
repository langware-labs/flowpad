export { AnchoredSurface } from './AnchoredSurface';
export { useAnchorVersion, useLineAnchorProvider } from './LineAnchorContext';
export { useReactMarkdownAnchor } from './providers/ReactMarkdownAnchorProvider';
export { buildTraceTrack, type TraceMark, type TraceMarkStatus } from './tracks/TraceTrack';
export { buildIssueTrack, type IssueMark, type IssueSeverity } from './tracks/IssueTrack';
export {
  buildMarkerTrack,
  MARKER_TRACK_WIDTH,
  type MarkerItem,
  type MarkerTrackOptions,
} from './tracks/MarkerTrack';
export { CommentPin, type CommentMark } from './CommentPin';
export type { Anchor, AnchoredItem, AnchoredTrack, LineAnchorProvider, LineRect } from './types';
