/**
 * IssueChip — a single issue surfaced inside an expanded StepCard.
 *
 * Visual: amber rounded card with a warning icon, title (kind, prettified),
 * detail body, and an optional recommendation block underneath.
 */

import { AlertTriangle } from "lucide-react";

import type { AnalysisIssue } from "./types";

const KIND_LABELS: Record<string, string> = {
  incomplete: "Step did not finish",
  wrong_tool: "Better tool available",
  retry: "Repeated work",
  mid_run_toolsearch: "Tool loaded mid-run",
  protocol_violation: "Protocol violation",
};

function prettyKind(kind: string): string {
  return KIND_LABELS[kind] ?? kind.replace(/_/g, " ");
}

interface IssueChipProps {
  issue: AnalysisIssue;
  recommendation?: string;
}

export function IssueChip({ issue, recommendation }: IssueChipProps) {
  return (
    <div className="rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-900/50 dark:bg-amber-950/30">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-amber-900 dark:text-amber-200">
            {prettyKind(issue.kind)}
          </div>
          <div className="mt-1 text-xs leading-relaxed text-amber-900/80 dark:text-amber-200/80">
            {issue.detail}
          </div>
          {recommendation && (
            <div className="mt-2 border-t border-amber-200/70 pt-2 dark:border-amber-900/50">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
                Recommendation
              </div>
              <div className="mt-0.5 text-xs leading-relaxed text-amber-900/90 dark:text-amber-200/90">
                {recommendation}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
