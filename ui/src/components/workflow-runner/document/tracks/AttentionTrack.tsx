/**
 * Right-gutter track for the annotated document. One stack of severity
 * chips per step. In `simple` view mode, only ATTENTION + NOTABLE chips
 * appear — INFO is filtered. Expert mode shows all.
 *
 * Build helper produces an AnchoredTrack. Pure: filtering happens here,
 * not in the chip.
 */

import type { AnchoredTrack } from '@src/components/anchored-markdown';
import { SeverityTier, isVisibleInSimpleMode } from '@sdk/models/severity';

import type { NormalizedIssue, StepViewModel, ViewMode } from '../../data/types';
import { SeverityChip } from '../markers/SeverityChip';

export const ATTENTION_TRACK_WIDTH = 160;

interface BuildOptions {
  viewMode: ViewMode;
}

function filterIssues(issues: NormalizedIssue[], viewMode: ViewMode): NormalizedIssue[] {
  if (viewMode === 'expert') return issues;
  return issues.filter((i) => isVisibleInSimpleMode(i.tier));
}

interface StackPayload {
  line: number;
  issues: NormalizedIssue[];
}

export function buildAttentionTrack(
  steps: StepViewModel[],
  opts: BuildOptions,
): AnchoredTrack<StackPayload> {
  const items = steps
    .map((s) => ({
      id: `attention:${s.line}`,
      anchor: { line: s.line },
      data: { line: s.line, issues: filterIssues(s.issues, opts.viewMode) },
    }))
    .filter((it) => it.data.issues.length > 0);

  return {
    id: 'attention',
    side: 'right',
    width: ATTENTION_TRACK_WIDTH,
    items,
    renderItem: (item) => (
      <div
        data-testid="attention-chip-stack"
        data-line={item.data.line}
        className="flex flex-col gap-0.5 px-1 py-0.5"
      >
        {item.data.issues.map((issue, i) => (
          <SeverityChip key={i} issue={issue} />
        ))}
      </div>
    ),
  };
}

export { SeverityTier };
