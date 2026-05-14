import { isVisibleInSimpleMode } from '@sdk/models/severity';

import type { StepViewModel, ViewMode } from '../../data/types';
import { SeverityChip } from '../../document/markers/SeverityChip';

interface RawIssuesListProps {
  step: StepViewModel;
  viewMode: ViewMode;
}

/**
 * Expert-mode-only: full analyzer issues array, including info-tier
 * observations that the simple view hides.
 */
export function RawIssuesList({ step, viewMode }: RawIssuesListProps) {
  if (step.issues.length === 0) return null;
  const issues =
    viewMode === 'expert'
      ? step.issues
      : step.issues.filter((i) => isVisibleInSimpleMode(i.tier));
  if (issues.length === 0) return null;
  return (
    <details
      data-testid="expert-section-raw-issues"
      open
      className="rounded-md border bg-muted/30"
    >
      <summary className="cursor-pointer px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Raw issues ({issues.length})
      </summary>
      <ul className="space-y-2 border-t px-3 py-2">
        {issues.map((iss, i) => (
          <li key={i} className="space-y-1 text-xs">
            <SeverityChip issue={iss} />
            <p className="whitespace-pre-wrap leading-relaxed">{iss.message}</p>
            {(iss.threshold_ms || iss.actual_ms) && (
              <p className="text-[10px] tabular-nums text-muted-foreground">
                {iss.threshold_ms && `budget ${iss.threshold_ms}ms`}
                {iss.actual_ms && ` · actual ${iss.actual_ms}ms`}
              </p>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
