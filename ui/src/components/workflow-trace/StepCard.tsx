/**
 * StepCard — one row in the WorkflowTraceViewer's step list.
 *
 * Collapsed: status icon + step text + sub-line (duration · tool count · issue count).
 * Expanded: detail string, list of tool-call names, IssueChip per issue.
 */

import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Clock,
  MinusCircle,
  Wrench,
} from "lucide-react";
import { ReactNode } from "react";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@src/components/ui/accordion";
import { cn } from "@src/lib/utils";

import { IssueChip } from "./IssueChip";
import type { StepViewModel } from "./types";

function formatDuration(ms?: number): string {
  if (!ms) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s - m * 60);
  return `${m}m ${rs}s`;
}

function formatCost(usd?: number): string | null {
  if (usd === undefined || usd === null || usd <= 0) return null;
  if (usd < 0.001) return `<$0.001`;
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

interface StatusVisual {
  Icon: typeof CheckCircle2;
  color: string;
  label: string;
}

function statusVisual(step: StepViewModel): StatusVisual {
  if (step.status === "error") {
    return { Icon: AlertCircle, color: "text-destructive", label: "Failed" };
  }
  if (step.status === "skip") {
    return { Icon: MinusCircle, color: "text-muted-foreground", label: "Skipped" };
  }
  if (step.status === "incomplete") {
    return { Icon: Clock, color: "text-muted-foreground", label: "Incomplete" };
  }
  // done
  if (step.issues.length > 0) {
    return { Icon: AlertTriangle, color: "text-amber-500", label: "Passed with notes" };
  }
  return { Icon: CheckCircle2, color: "text-emerald-500", label: "Passed" };
}

interface StepCardProps {
  index: number; // 1-indexed display number
  step: StepViewModel;
}

export function StepCard({ index, step }: StepCardProps) {
  const { Icon, color, label } = statusVisual(step);
  const toolCount = step.tool_calls?.length ?? 0;
  const issueCount = step.issues.length;

  const subLineParts: ReactNode[] = [];
  if (step.duration_ms !== undefined) {
    subLineParts.push(<span key="dur">{formatDuration(step.duration_ms)}</span>);
  }
  const costLabel = formatCost(step.cost_usd);
  if (costLabel) {
    subLineParts.push(<span key="cost" data-testid="step-card-cost">{costLabel}</span>);
  }
  if (toolCount > 0) {
    subLineParts.push(
      <span key="tools">
        {toolCount} {toolCount === 1 ? "tool" : "tools"}
      </span>,
    );
  }
  if (issueCount > 0) {
    subLineParts.push(
      <span key="issues" className="text-amber-600 dark:text-amber-400">
        {issueCount} {issueCount === 1 ? "issue" : "issues"}
      </span>,
    );
  }
  const hasDetails =
    Boolean(step.detail) || toolCount > 0 || issueCount > 0;

  return (
    <Accordion type="single" collapsible>
      <AccordionItem
        value="step"
        className="overflow-hidden rounded-md border bg-card data-[state=open]:shadow-sm"
      >
        <AccordionTrigger
          className={cn(
            "px-3 py-2.5 text-left hover:bg-muted/40 hover:no-underline data-[state=open]:bg-muted/30",
            !hasDetails && "[&>svg]:opacity-30 [&>svg]:cursor-default",
          )}
          disabled={!hasDetails}
          data-testid="workflow-trace-step"
        >
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <Icon className={cn("h-4 w-4 shrink-0", color)} aria-label={label} />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Step {index}
                </span>
              </div>
              <div className="mt-0.5 truncate text-sm text-foreground">
                {step.step_text}
              </div>
              {subLineParts.length > 0 && (
                <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  {subLineParts.flatMap((p, i) =>
                    i === 0 ? [p] : [<span key={`sep-${i}`}>·</span>, p],
                  )}
                </div>
              )}
            </div>
          </div>
        </AccordionTrigger>
        <AccordionContent className="border-t bg-muted/20 px-3 py-3">
          <div className="space-y-3">
            {step.detail && (
              <div className="text-xs leading-relaxed text-foreground/90">
                {step.detail}
              </div>
            )}
            {step.tool_calls && step.tool_calls.length > 0 && (
              <div className="space-y-1.5">
                <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  <Wrench className="h-3 w-3" />
                  Tools used
                </div>
                <ul className="space-y-1">
                  {step.tool_calls.map((tc, i) => (
                    <li
                      key={`${tc.name}-${i}`}
                      className="rounded border border-border/60 bg-background px-2 py-1.5"
                    >
                      <div className="font-mono text-[11px] text-foreground">
                        {tc.name}
                      </div>
                      {tc.result_summary && (
                        <div className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                          {tc.result_summary}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {step.issues.length > 0 && (
              <div className="space-y-2">
                {step.issues.map((issue, i) => (
                  <IssueChip
                    key={`${issue.kind}-${i}`}
                    issue={issue}
                    recommendation={i === 0 ? step.recommendation : undefined}
                  />
                ))}
              </div>
            )}
          </div>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}
