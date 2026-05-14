/**
 * Left-gutter track for the annotated document. One marker per step,
 * showing ✓/✗ + duration + cost + sparkline-across-runs.
 *
 * Build helper produces an AnchoredTrack the existing AnchoredSurface
 * (REUSED from anchored-markdown/) renders. No data fetching or merging.
 */

import type { AnchoredTrack } from '@src/components/anchored-markdown';

import type { StepHistory, StepViewModel } from '../../data/types';
import { StepStatusMarker } from '../markers/StepStatusMarker';

export const STATUS_TRACK_WIDTH = 140;

interface BuildOptions {
  /** History per step line; used by sparkline. */
  history: Map<number, StepHistory>;
  /** Currently selected line for hover highlight. */
  selectedLine: number | null;
  /** Click handler — emits the clicked step's line. */
  onSelect: (line: number) => void;
}

export function buildStatusTrack(
  steps: StepViewModel[],
  opts: BuildOptions,
): AnchoredTrack<StepViewModel> {
  return {
    id: 'status',
    side: 'left',
    width: STATUS_TRACK_WIDTH,
    items: steps.map((step) => ({
      id: `status:${step.line}`,
      anchor: { line: step.line },
      data: step,
    })),
    renderItem: (item) => (
      <StepStatusMarker
        step={item.data}
        history={opts.history.get(item.data.line)}
        isSelected={opts.selectedLine === item.data.line}
        onClick={() => opts.onSelect(item.data.line)}
      />
    ),
  };
}
