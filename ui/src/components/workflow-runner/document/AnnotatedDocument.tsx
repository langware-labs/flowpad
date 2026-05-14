/**
 * The workflow .md rendered as the canvas, with status (left) and
 * attention (right) gutter tracks anchored to step bullet lines.
 *
 * REUSES `AnchoredSurface` + `useReactMarkdownAnchor` from
 * `ui/src/components/anchored-markdown/`. The annotated-document
 * pattern is the existing primitive — this component just composes
 * track-builders into it.
 *
 * Pure render: receives `runs`, `stepHistory`, `selectedLine`, `viewMode`
 * and `onSelectStep`. No data fetching, no schema parsing.
 */

import {
  AnchoredSurface,
  useReactMarkdownAnchor,
} from '@src/components/anchored-markdown';
import { useMemo } from 'react';

import type { RunViewModel, StepHistory, ViewMode } from '../data/types';
import { buildAttentionTrack } from './tracks/AttentionTrack';
import { buildStatusTrack } from './tracks/StatusTrack';

interface AnnotatedDocumentProps {
  /** The workflow markdown source. */
  source: string;
  /** All selected runs (length 1 in Phase 2; N in Phase 4 overlay mode). */
  runs: RunViewModel[];
  /** Per-step history slice — fuel for the sparkline. */
  stepHistory: Map<number, StepHistory>;
  /** Active step line (for hover highlight + right-pane wiring). */
  selectedLine: number | null;
  /** Simple vs expert visibility for the AttentionTrack. */
  viewMode: ViewMode;
  /** Step-click handler — emits the clicked line. */
  onSelectStep: (line: number) => void;
}

export function AnnotatedDocument({
  source,
  runs,
  stepHistory,
  selectedLine,
  viewMode,
  onSelectStep,
}: AnnotatedDocumentProps) {
  const { body, provider } = useReactMarkdownAnchor(source);

  // Phase 2: only the first (active) run feeds the gutter. Phase 4 will
  // stack across all `runs`.
  const activeRun = runs[0];
  const steps = activeRun?.steps ?? [];

  const statusTrack = useMemo(
    () =>
      buildStatusTrack(steps, {
        history: stepHistory,
        selectedLine,
        onSelect: onSelectStep,
      }),
    [steps, stepHistory, selectedLine, onSelectStep],
  );

  const attentionTrack = useMemo(
    () => buildAttentionTrack(steps, { viewMode }),
    [steps, viewMode],
  );

  return (
    <div data-testid="annotated-document" className="h-full overflow-auto">
      <AnchoredSurface
        provider={provider}
        leftTracks={[statusTrack]}
        rightTracks={[attentionTrack]}
        className="transition-opacity duration-150"
      >
        {body}
      </AnchoredSurface>
    </div>
  );
}
