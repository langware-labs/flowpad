/**
 * RunSummaryBanner — top-of-viewer pass/fail summary card.
 *
 * Shows the single biggest signal a non-tech user needs: "did this work?"
 *   ✅ All N steps passed              (green, when no errors and no issues)
 *   ⚠️  All N steps passed · M issues   (amber, when notes exist)
 *   ❌ X of N steps failed              (red, when any error)
 *   ⏳ X of N steps still pending      (gray, when incomplete)
 */

import { AlertTriangle, CheckCircle2, AlertCircle, Clock } from "lucide-react";
import { cn } from "@src/lib/utils";

import type { RunSummary } from "./types";

interface RunSummaryBannerProps {
  summary: RunSummary;
  /** Whether the analysis JSONL was found. Used for footnote text. */
  hasAnalysis: boolean;
}

function formatDuration(ms: number): string {
  if (ms === 0) return "—";
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec - m * 60;
  return `${m}m ${s}s`;
}

export function RunSummaryBanner({ summary, hasAnalysis }: RunSummaryBannerProps) {
  const { cleanCount, warnCount, errorCount, pendingCount, totalDurationMs, total } = summary;
  const passedCount = cleanCount + warnCount;

  // Decide overall tone (red > amber > gray > green)
  let tone: "success" | "warn" | "error" | "pending";
  if (errorCount > 0) tone = "error";
  else if (pendingCount > 0 && passedCount === 0) tone = "pending";
  else if (warnCount > 0) tone = "warn";
  else if (pendingCount > 0) tone = "pending";
  else tone = "success";

  const headlineText = (() => {
    if (errorCount > 0) {
      return `${errorCount} of ${total} ${total === 1 ? "step" : "steps"} failed`;
    }
    if (pendingCount > 0 && passedCount === 0) {
      return `${pendingCount} of ${total} ${total === 1 ? "step" : "steps"} pending`;
    }
    if (passedCount === total && total > 0) {
      return `All ${total} ${total === 1 ? "step" : "steps"} passed`;
    }
    return `${passedCount} of ${total} ${total === 1 ? "step" : "steps"} passed`;
  })();

  const subText = (() => {
    const parts: string[] = [];
    if (totalDurationMs > 0) parts.push(formatDuration(totalDurationMs));
    if (warnCount > 0)
      parts.push(`${warnCount} ${warnCount === 1 ? "issue" : "issues"} worth attention`);
    if (pendingCount > 0 && passedCount > 0)
      parts.push(`${pendingCount} pending`);
    return parts.join(" · ");
  })();

  const toneStyles: Record<typeof tone, { wrapper: string; iconColor: string; Icon: typeof CheckCircle2 }> = {
    success: {
      wrapper:
        "border-emerald-200 bg-emerald-50 dark:border-emerald-900/40 dark:bg-emerald-950/30",
      iconColor: "text-emerald-600 dark:text-emerald-400",
      Icon: CheckCircle2,
    },
    warn: {
      wrapper:
        "border-amber-200 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-950/30",
      iconColor: "text-amber-600 dark:text-amber-400",
      Icon: AlertTriangle,
    },
    error: {
      wrapper:
        "border-red-200 bg-red-50 dark:border-red-900/40 dark:bg-red-950/30",
      iconColor: "text-red-600 dark:text-red-400",
      Icon: AlertCircle,
    },
    pending: {
      wrapper: "border-border bg-muted/40",
      iconColor: "text-muted-foreground",
      Icon: Clock,
    },
  };
  const { wrapper, iconColor, Icon } = toneStyles[tone];

  return (
    <div
      className={cn("rounded-md border p-4", wrapper)}
      data-testid="workflow-trace-summary"
    >
      <div className="flex items-start gap-3">
        <Icon className={cn("h-5 w-5 shrink-0 mt-0.5", iconColor)} aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-foreground">{headlineText}</div>
          {subText && <div className="mt-0.5 text-xs text-muted-foreground">{subText}</div>}
          {!hasAnalysis && (
            <div className="mt-1.5 text-[11px] italic text-muted-foreground">
              Analysis not available yet — step issues will appear once it completes.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
