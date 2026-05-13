/**
 * WorkflowTraceViewer — annotated-markdown view of one workflow run.
 *
 * Layout: 3-column CSS grid, **one row per source line** of the workflow
 * markdown.
 *
 *    LEFT GUTTER         CENTER (pure markdown)        RIGHT GUTTER
 *    time + status       rendered prose                issue chips
 *    duration            (heading / bullet / etc)      recommendation
 *    tools used
 *
 * Goal: looks like a clean annotated doc — markdown reads naturally; trace
 * + analysis annotations sit beside their step lines without disrupting
 * prose flow. Lines that have no step events render with empty gutters
 * (preserves alignment).
 */

import {
  AlertCircle,
  AlertOctagon,
  AlertTriangle,
  ArrowLeft,
  Brain,
  CheckCircle2,
  Clock,
  History,
  Loader2,
  MinusCircle,
  Play,
  Wrench,
} from "lucide-react";
import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";

import { Button } from "@src/components/ui/button";
import { ScrollArea } from "@src/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@src/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@src/components/ui/tooltip";
import { cn } from "@src/lib/utils";

import { FeedbackPanel } from "./FeedbackPanel";
import { HistoryPanel } from "./HistoryPanel";
import { MemoryPanel } from "./MemoryPanel";
import { useWorkflowLearningArtifacts } from "./useWorkflowLearningArtifacts";
import { useWorkflowTraceData } from "./useWorkflowTraceData";
import type {
  AnalysisIssue,
  AnalysisToolCall,
  StepViewModel,
} from "./types";

// ─── Props ──────────────────────────────────────────────────────────────────

interface WorkflowTraceViewerProps {
  processId?: string;
  outputFolderPath?: string;
  /** Workflow's record data folder. When provided, Memory · History ·
   *  Feedback tabs become available. When absent, only Run is shown. */
  workflowDataDir?: string;
  onBack?: () => void;
}

// ─── Markdown line parsing ──────────────────────────────────────────────────

type LineKind =
  | "h1"
  | "h2"
  | "h3"
  | "h4"
  | "paragraph"
  | "bullet"
  | "empty"
  | "hr"
  | "frontmatter";

interface ParsedLine {
  /** 1-indexed source line number — the trace's `(file, line)` anchor key. */
  n: number;
  kind: LineKind;
  /** Stripped of leading marker (heading hashes, list bullet). */
  content: string;
  /** Raw line, unmodified. */
  raw: string;
}

function parseLines(text: string): ParsedLine[] {
  const lines = text.split("\n");
  const out: ParsedLine[] = [];
  let inFrontmatter = false;
  for (let i = 0; i < lines.length; i++) {
    const n = i + 1;
    const raw = lines[i];
    const trimmed = raw.trim();

    if (i === 0 && trimmed === "---") {
      inFrontmatter = true;
      out.push({ n, kind: "frontmatter", content: "", raw });
      continue;
    }
    if (inFrontmatter) {
      out.push({ n, kind: "frontmatter", content: "", raw });
      if (trimmed === "---") inFrontmatter = false;
      continue;
    }

    if (trimmed === "") {
      out.push({ n, kind: "empty", content: "", raw });
      continue;
    }

    const h = trimmed.match(/^(#+)\s+(.+)$/);
    if (h) {
      const lvl = Math.min(4, h[1].length);
      out.push({
        n,
        kind: `h${lvl}` as LineKind,
        content: h[2],
        raw,
      });
      continue;
    }

    const bullet = trimmed.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      out.push({ n, kind: "bullet", content: bullet[1], raw });
      continue;
    }

    if (trimmed === "---" || trimmed === "***" || trimmed === "___") {
      out.push({ n, kind: "hr", content: "", raw });
      continue;
    }

    out.push({ n, kind: "paragraph", content: trimmed, raw });
  }
  return out;
}

// ─── Inline rendering — minimal markdown subset ─────────────────────────────

/**
 * Render a string with inline ``code`` segments preserved. Other inline
 * markdown (bold, italic, links) is dropped through as plain text — v1
 * targets workflow steps, which are typically short imperative lines with
 * occasional code spans.
 */
function renderInline(text: string): ReactNode {
  if (!text.includes("`")) return text;
  const parts = text.split(/(`[^`]+`)/);
  return parts.map((part, i) => {
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code
          key={i}
          className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    return <Fragment key={i}>{part}</Fragment>;
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function fmtDuration(ms?: number): string {
  if (!ms) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s - m * 60);
  return `${m}m ${rs}s`;
}

function fmtCost(usd?: number): string | null {
  if (usd === undefined || usd === null || usd <= 0) return null;
  if (usd < 0.001) return `<$0.001`;
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

function fmtClock(iso?: string): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  } catch {
    return "";
  }
}

function prettifyToolName(name: string): string {
  // mcp__debugMcp__browser_navigate → browser_navigate
  return name.replace(/^mcp__[^_]+__/, "");
}

const ISSUE_LABELS: Record<string, string> = {
  incomplete: "Step did not finish",
  wrong_tool: "Better tool available",
  retry: "Repeated work",
  mid_run_toolsearch: "Tool loaded mid-run",
  protocol_violation: "Protocol violation",
};
function prettyIssueKind(kind: string): string {
  return ISSUE_LABELS[kind] ?? kind.replace(/_/g, " ");
}

function statusVisual(step: StepViewModel) {
  if (step.status === "error") {
    return { Icon: AlertCircle, color: "text-destructive", label: "Failed" };
  }
  if (step.status === "skip") {
    return { Icon: MinusCircle, color: "text-muted-foreground", label: "Skipped" };
  }
  if (step.status === "incomplete") {
    return { Icon: Clock, color: "text-muted-foreground", label: "Incomplete" };
  }
  if (step.issues.length > 0) {
    return { Icon: AlertTriangle, color: "text-amber-500", label: "Passed with notes" };
  }
  return { Icon: CheckCircle2, color: "text-emerald-500", label: "Passed" };
}

// ─── Gutter components ─────────────────────────────────────────────────────

/** LEFT gutter — one-line: status icon + duration. Tooltip = tools + detail. */
function LeftGutter({ step }: { step: StepViewModel | undefined }) {
  if (!step) return null;
  const { Icon, color, label } = statusVisual(step);

  const hasTooltipContent =
    Boolean(step.detail) ||
    (step.tool_calls && step.tool_calls.length > 0);

  const costLabel = fmtCost(step.cost_usd);
  const line = (
    <div className="flex items-center justify-end gap-1.5 whitespace-nowrap text-[11px] leading-none">
      <Icon
        className={cn("h-3.5 w-3.5 shrink-0", color)}
        aria-label={label}
      />
      <span className={cn("font-medium tabular-nums", color)}>
        {step.duration_ms !== undefined ? fmtDuration(step.duration_ms) : label}
      </span>
      {costLabel && (
        <span
          className="tabular-nums text-muted-foreground"
          data-testid="workflow-step-cost"
        >
          {costLabel}
        </span>
      )}
    </div>
  );

  if (!hasTooltipContent) return line;

  return (
    <Tooltip delayDuration={150}>
      <TooltipTrigger asChild>
        <div className="cursor-help">{line}</div>
      </TooltipTrigger>
      <TooltipContent side="left" align="start" className="max-w-sm space-y-1.5 p-2.5 text-xs">
        <div className="flex items-center gap-1.5">
          <Icon className={cn("h-3.5 w-3.5", color)} />
          <span className={cn("font-medium", color)}>{label}</span>
          {step.duration_ms !== undefined && (
            <span className="text-muted-foreground">
              · {fmtDuration(step.duration_ms)}
            </span>
          )}
        </div>
        {step.detail && (
          <div className="leading-relaxed text-foreground/90">
            {step.detail}
          </div>
        )}
        {step.tool_calls && step.tool_calls.length > 0 && (
          <div className="space-y-1 border-t border-border/60 pt-1.5">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Tools used
            </div>
            {step.tool_calls.map((tc, i) => (
              <ToolDetail key={`${tc.name}-${i}`} tc={tc} />
            ))}
          </div>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

function ToolDetail({ tc }: { tc: AnalysisToolCall }) {
  return (
    <div>
      <div className="font-mono text-[11px] text-foreground">
        {prettifyToolName(tc.name)}
      </div>
      {tc.result_summary && (
        <div className="text-[11px] leading-snug text-muted-foreground">
          {tc.result_summary}
        </div>
      )}
    </div>
  );
}

/** RIGHT gutter — one-line chip per issue (or "+N more" when crowded).
 *  Tooltip on each chip = full detail + (first chip's) recommendation. */
function RightGutter({ step }: { step: StepViewModel | undefined }) {
  if (!step || step.issues.length === 0) return null;

  // Show first 2 issue chips inline; collapse the rest behind a "+N" pill.
  // Keeps the row's vertical footprint tight even when a step has many issues.
  const MAX_INLINE = 2;
  const visible = step.issues.slice(0, MAX_INLINE);
  const overflow = step.issues.slice(MAX_INLINE);

  return (
    <div className="flex flex-wrap items-center gap-1">
      {visible.map((issue, i) => (
        <IssueChip
          key={`${issue.kind}-${i}`}
          issue={issue}
          recommendation={i === 0 ? step.recommendation : undefined}
        />
      ))}
      {overflow.length > 0 && (
        <Tooltip delayDuration={150}>
          <TooltipTrigger asChild>
            <span className="cursor-help rounded-full border border-amber-200/70 bg-amber-50/70 px-1.5 py-[1px] text-[10px] font-medium text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
              +{overflow.length}
            </span>
          </TooltipTrigger>
          <TooltipContent side="right" align="start" className="max-w-sm space-y-1.5 p-2.5 text-xs">
            {overflow.map((issue, i) => (
              <div key={`ov-${i}`} className="space-y-0.5">
                <div className="flex items-center gap-1.5 font-medium text-amber-900 dark:text-amber-200">
                  <AlertTriangle className="h-3 w-3" />
                  {prettyIssueKind(issue.kind)}
                </div>
                <div className="leading-snug text-foreground/85">
                  {issue.detail}
                </div>
              </div>
            ))}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

function IssueChip({
  issue,
  recommendation,
}: {
  issue: AnalysisIssue;
  recommendation?: string;
}) {
  return (
    <Tooltip delayDuration={150}>
      <TooltipTrigger asChild>
        <span
          className="inline-flex max-w-full cursor-help items-center gap-1 truncate whitespace-nowrap rounded-full border border-amber-200/70 bg-amber-50/70 px-2 py-[2px] text-[11px] font-medium leading-none text-amber-900 hover:bg-amber-100/80 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200 dark:hover:bg-amber-900/40"
          data-testid="workflow-trace-issue"
        >
          <AlertTriangle className="h-3 w-3 shrink-0" />
          <span className="truncate">{prettyIssueKind(issue.kind)}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" align="start" className="max-w-sm space-y-1.5 p-2.5 text-xs">
        <div className="flex items-center gap-1.5 font-medium text-amber-900 dark:text-amber-200">
          <AlertTriangle className="h-3.5 w-3.5" />
          {prettyIssueKind(issue.kind)}
        </div>
        <div className="leading-relaxed text-foreground/90">{issue.detail}</div>
        {recommendation && (
          <div className="space-y-0.5 border-t border-border/60 pt-1.5">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
              Fix
            </div>
            <div className="leading-relaxed text-foreground/90">
              {recommendation}
            </div>
          </div>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

// ─── Center cell — markdown line ───────────────────────────────────────────

function MarkdownLine({
  line,
  hasStep,
}: {
  line: ParsedLine;
  hasStep: boolean;
}) {
  const baseHover = hasStep
    ? "rounded -mx-1 px-1 transition-colors hover:bg-muted/40"
    : "";

  switch (line.kind) {
    case "h1":
      return (
        <h1 className="!my-0 text-2xl font-semibold tracking-tight">
          {renderInline(line.content)}
        </h1>
      );
    case "h2":
      return (
        <h2 className="!my-0 text-lg font-semibold tracking-tight">
          {renderInline(line.content)}
        </h2>
      );
    case "h3":
      return (
        <h3 className="!my-0 text-base font-semibold tracking-tight">
          {renderInline(line.content)}
        </h3>
      );
    case "h4":
      return (
        <h4 className="!my-0 text-sm font-semibold tracking-tight">
          {renderInline(line.content)}
        </h4>
      );
    case "bullet":
      return (
        <div className={cn("flex gap-2 text-sm leading-relaxed", baseHover)}>
          <span className="select-none text-muted-foreground">•</span>
          <span>{renderInline(line.content)}</span>
        </div>
      );
    case "paragraph":
      return (
        <p className="!my-0 text-sm leading-relaxed">
          {renderInline(line.content)}
        </p>
      );
    case "empty":
      return <div className="h-2" />;
    case "hr":
      return <hr className="!my-1 border-border/60" />;
    case "frontmatter":
      // Hidden — but we still render an empty cell to keep grid alignment
      // for any callers that pass frontmatter rows through.
      return null;
  }
}

// ─── Top run-summary bar ───────────────────────────────────────────────────

function RunSummary({
  steps,
  totalMs,
  totalCostUsd,
  hasAnalysis,
}: {
  steps: StepViewModel[];
  totalMs: number;
  totalCostUsd?: number;
  hasAnalysis: boolean;
}) {
  const total = steps.length;
  const passed = steps.filter((s) => s.status === "done").length;
  const failed = steps.filter((s) => s.status === "error").length;
  const issues = steps.reduce((acc, s) => acc + s.issues.length, 0);

  let tone: "success" | "warn" | "error" | "muted" = "muted";
  if (total === 0) tone = "muted";
  else if (failed > 0) tone = "error";
  else if (issues > 0) tone = "warn";
  else if (passed === total) tone = "success";

  const toneColor =
    tone === "error"
      ? "text-destructive"
      : tone === "warn"
      ? "text-amber-600 dark:text-amber-400"
      : tone === "success"
      ? "text-emerald-600 dark:text-emerald-400"
      : "text-muted-foreground";

  const headline =
    failed > 0
      ? `${failed} of ${total} steps failed`
      : passed === total && total > 0
      ? `All ${total} steps passed`
      : `${passed} of ${total} steps passed`;

  const sub: string[] = [];
  if (totalMs > 0) sub.push(fmtDuration(totalMs));
  const costLabel = fmtCost(totalCostUsd);
  if (costLabel) sub.push(costLabel);
  if (issues > 0) sub.push(`${issues} ${issues === 1 ? "issue" : "issues"}`);
  if (!hasAnalysis) sub.push("analysis pending");

  return (
    <div className="flex items-baseline gap-2 text-sm" data-testid="workflow-run-summary">
      <span className={cn("font-medium", toneColor)}>{headline}</span>
      {sub.length > 0 && (
        <span className="text-xs text-muted-foreground">{sub.join(" · ")}</span>
      )}
    </div>
  );
}

// ─── Top-level ─────────────────────────────────────────────────────────────

export function WorkflowTraceViewer({
  processId,
  outputFolderPath,
  workflowDataDir,
  onBack,
}: WorkflowTraceViewerProps) {
  // selectedArchive overrides outputFolderPath when the user picks a
  // historical run from the History tab. Reset when external props change.
  const [selectedArchive, setSelectedArchive] = useState<string | null>(null);
  useEffect(() => {
    setSelectedArchive(null);
  }, [processId, outputFolderPath]);

  const activeOutputFolder = selectedArchive ?? outputFolderPath;
  const view = useWorkflowTraceData({
    processId: selectedArchive ? undefined : processId,
    outputFolderPath: activeOutputFolder,
  });
  const learning = useWorkflowLearningArtifacts(
    workflowDataDir,
    activeOutputFolder,
  );

  // Tab state. Auto-focus Feedback on first paint when feedback.md exists
  // AND its content hash differs from the last 'seen' value in localStorage.
  const [activeTab, setActiveTab] = useState<string>("run");
  useEffect(() => {
    if (!learning.feedback || !workflowDataDir) return;
    const key = `wft.feedback_seen.${workflowDataDir}`;
    let hash = 0;
    for (let i = 0; i < learning.feedback.content.length; i++) {
      hash = ((hash << 5) - hash + learning.feedback.content.charCodeAt(i)) | 0;
    }
    const currentHash = String(hash);
    let seen: string | null = null;
    try {
      seen = window.localStorage.getItem(key);
    } catch {
      /* private mode — ignore */
    }
    if (seen !== currentHash) {
      setActiveTab("feedback");
      try {
        window.localStorage.setItem(key, currentHash);
      } catch {
        /* ignore */
      }
    }
  }, [learning.feedback, workflowDataDir]);

  // Build the full markdown text we'll render. Phase 1 split header off; for
  // the gutter view we want every line — header, steps, references — to flow
  // as one annotated document. The trace anchors point at line numbers in
  // the original file, so we read directly from `view.workflowFile`'s text.
  // The hook already fetched it (it's in `view.header` only as a slice; the
  // full text is needed). We re-derive by re-loading: cheaper to keep one
  // string of the full doc reachable through the hook in a follow-up.
  // For now fall back to the header slice when the full text isn't carried
  // through — gives users at least the header rendered, and step-line
  // anchors will simply point past the rendered slice (rare in practice).

  const stepByLine = useMemo(() => {
    const m = new Map<number, StepViewModel>();
    for (const s of view.steps) m.set(s.line, s);
    return m;
  }, [view.steps]);

  const lines = useMemo(() => parseLines(view.fullText ?? view.header ?? ""), [view.fullText, view.header]);

  const totalMs = useMemo(
    () =>
      view.steps.reduce((acc, s) => acc + (s.duration_ms ?? 0), 0),
    [view.steps],
  );

  const visibleLines = lines.filter((l) => l.kind !== "frontmatter");

  // ── Run tab body — the existing annotated-markdown render. ────────────
  const runBody = (
    <ScrollArea className="flex-1">
      {visibleLines.length === 0 ? (
        <div className="mx-auto max-w-3xl p-8 text-center text-sm text-muted-foreground">
          {view.isLoading ? "Loading workflow…" : view.error ?? "No content."}
        </div>
      ) : (
        <div className="mx-auto max-w-6xl px-6 py-6">
          <div
            className="grid items-start gap-x-4"
            style={{
              gridTemplateColumns: "minmax(80px, 110px) minmax(0, 1fr) minmax(180px, 260px)",
              rowGap: "0.25rem",
            }}
            data-testid="workflow-trace-grid"
          >
            {visibleLines.map((line) => {
              const step = stepByLine.get(line.n);
              return (
                <Fragment key={line.n}>
                  {/* LEFT */}
                  <div
                    className="pt-[3px]"
                    data-testid={step ? "workflow-trace-step" : undefined}
                    data-line={line.n}
                  >
                    <LeftGutter step={step} />
                  </div>
                  {/* CENTER */}
                  <div
                    className={cn(
                      step && "border-l-2 border-amber-300/40 pl-3 dark:border-amber-700/40",
                      step && step.issues.length === 0 && "border-emerald-300/40 dark:border-emerald-700/40",
                      step && step.status === "error" && "border-destructive/50",
                    )}
                  >
                    <MarkdownLine line={line} hasStep={!!step} />
                  </div>
                  {/* RIGHT */}
                  <div className="pt-[2px]">
                    <RightGutter step={step} />
                  </div>
                </Fragment>
              );
            })}
          </div>
        </div>
      )}
    </ScrollArea>
  );

  const showLearningTabs = !!workflowDataDir;

  return (
    <TooltipProvider>
      <div
        className="flex h-full flex-col bg-background"
        data-testid="workflow-trace-viewer"
      >
        {/* Top bar */}
        <div className="flex items-center justify-between border-b px-4 py-2.5">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={onBack}
              className="h-7 gap-1.5 text-xs"
              data-testid="workflow-trace-back"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Back
            </Button>
            <RunSummary
              steps={view.steps}
              totalMs={totalMs}
              totalCostUsd={view.summary.totalCostUsd}
              hasAnalysis={view.hasAnalysis}
            />
            {selectedArchive && (
              <button
                type="button"
                onClick={() => setSelectedArchive(null)}
                className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground hover:bg-muted/70"
                data-testid="workflow-trace-clear-archive"
              >
                viewing archive · clear
              </button>
            )}
          </div>
          {view.isLoading && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Loading
            </div>
          )}
        </div>

        {showLearningTabs ? (
          <Tabs
            value={activeTab}
            onValueChange={setActiveTab}
            className="flex flex-1 flex-col overflow-hidden"
          >
            <TabsList
              className="mx-4 mt-2 self-start"
              data-testid="workflow-trace-tabs"
            >
              <TabsTrigger value="run" className="gap-1.5">
                <Play className="h-3 w-3" />
                Run
              </TabsTrigger>
              <TabsTrigger value="memory" className="gap-1.5">
                <Brain className="h-3 w-3" />
                Memory
                {learning.memory && (
                  <span className="ml-1 rounded-full bg-muted px-1.5 py-[1px] text-[10px] tabular-nums text-muted-foreground">
                    {Math.round(learning.memory.bytes / 100) / 10}KB
                  </span>
                )}
              </TabsTrigger>
              <TabsTrigger value="history" className="gap-1.5">
                <History className="h-3 w-3" />
                History
                {learning.history.length > 0 && (
                  <span className="ml-1 rounded-full bg-muted px-1.5 py-[1px] text-[10px] tabular-nums text-muted-foreground">
                    {learning.history.length}
                  </span>
                )}
              </TabsTrigger>
              {learning.feedback && (
                <TabsTrigger
                  value="feedback"
                  className="gap-1.5 data-[state=active]:text-amber-700 dark:data-[state=active]:text-amber-300"
                >
                  <AlertOctagon className="h-3 w-3 text-amber-600 dark:text-amber-400" />
                  Feedback
                  <span className="ml-1 h-1.5 w-1.5 rounded-full bg-amber-500" />
                </TabsTrigger>
              )}
            </TabsList>
            <TabsContent value="run" className="flex-1 overflow-hidden">
              {runBody}
            </TabsContent>
            <TabsContent value="memory" className="flex-1 overflow-auto">
              <MemoryPanel memory={learning.memory} />
            </TabsContent>
            <TabsContent value="history" className="flex-1 overflow-auto">
              <HistoryPanel
                history={learning.history}
                learningLog={learning.learningLog}
                onSelectArchive={(dir) => {
                  setSelectedArchive(dir);
                  setActiveTab("run");
                }}
              />
            </TabsContent>
            {learning.feedback && (
              <TabsContent value="feedback" className="flex-1 overflow-auto">
                <FeedbackPanel feedback={learning.feedback} />
              </TabsContent>
            )}
          </Tabs>
        ) : (
          runBody
        )}
      </div>
    </TooltipProvider>
  );
}
