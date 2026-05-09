/**
 * useWorkflowTraceData — given an AgenticProcess id, load:
 *   - the trace JSONL  (output_folder/workflow.trace.jsonl)
 *   - the analysis JSONL (output_folder/workflow.analysis.jsonl)  [optional]
 *   - the workflow markdown file (resolved from anchor.file in those records)
 *
 * Returns a merged view-model the components can render directly.
 *
 * Greedy: a missing analysis is fine; a missing trace renders an empty state;
 * a missing workflow file renders steps without prose context. None of these
 * surfaces are fatal.
 */

import { useEffect, useMemo, useState } from "react";
import { AgenticProcess, FSRef, TypeId } from "@sdk";
import { useEntity } from "@sdk/react/hooks";
import { useAgentContext } from "@src/components/agent-layout/agent-layout";

import type {
  AnalysisRecord,
  AnalyzedStatus,
  RunSummary,
  StepViewModel,
  WorkflowReportEntry,
  WorkflowTraceViewModel,
} from "./types";

interface JsonlFileState<T> {
  records: T[];
  isLoading: boolean;
  /** True iff the file was read and parsed successfully (even if empty). */
  found: boolean;
  /** Non-fatal error message (file missing, permission, etc). */
  error: string | null;
}

/**
 * Minimal one-shot JSONL reader. Doesn't try to recover or auto-create
 * (unlike useFSRefContent) — missing file ⇒ found=false + records=[].
 */
function useJsonlFile<T>(fsRef: FSRef | null): JsonlFileState<T> {
  const [state, setState] = useState<JsonlFileState<T>>({
    records: [],
    isLoading: false,
    found: false,
    error: null,
  });
  const path = fsRef?.path ?? null;

  useEffect(() => {
    if (!fsRef) {
      setState({ records: [], isLoading: false, found: false, error: null });
      return;
    }
    let cancelled = false;
    setState({ records: [], isLoading: true, found: false, error: null });
    fsRef
      .read()
      .then((text) => {
        if (cancelled) return;
        const lines = text.split("\n").filter((l) => l.trim());
        const records: T[] = [];
        for (const line of lines) {
          try {
            records.push(JSON.parse(line) as T);
          } catch (e) {
            console.warn(
              `[useJsonlFile] failed to parse line in ${fsRef.path}:`,
              e,
            );
          }
        }
        setState({ records, isLoading: false, found: true, error: null });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({
          records: [],
          isLoading: false,
          found: false,
          error: String((err as Error)?.message ?? err),
        });
      });
    return () => {
      cancelled = true;
    };
    // path is the stable identity of the FSRef
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  return state;
}

/** Read a single text file into a string. Same shape as useJsonlFile but skipping the parse. */
function useTextFile(fsRef: FSRef | null): {
  text: string | null;
  isLoading: boolean;
  found: boolean;
} {
  const [state, setState] = useState<{
    text: string | null;
    isLoading: boolean;
    found: boolean;
  }>({ text: null, isLoading: false, found: false });
  const path = fsRef?.path ?? null;

  useEffect(() => {
    if (!fsRef) {
      setState({ text: null, isLoading: false, found: false });
      return;
    }
    let cancelled = false;
    setState({ text: null, isLoading: true, found: false });
    fsRef
      .read()
      .then((text) => {
        if (cancelled) return;
        setState({ text, isLoading: false, found: true });
      })
      .catch(() => {
        if (cancelled) return;
        setState({ text: null, isLoading: false, found: false });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  return state;
}

// ─── Merge logic (trace + analysis → step view-model) ───────────────────────

type AnchorKey = string; // `${file}::${line}`

function anchorKey(file: string, line: number): AnchorKey {
  return `${file}::${line}`;
}

interface TracePair {
  enter: WorkflowReportEntry;
  terminal: WorkflowReportEntry | null;
}

function pairTraceEvents(events: WorkflowReportEntry[]): Map<AnchorKey, TracePair> {
  // Walk in chronological order (events are usually written in order, but
  // sort defensively so a clock-skewed line doesn't reshape the trace).
  const sorted = [...events].sort((a, b) => a.ts.localeCompare(b.ts));
  const pairs = new Map<AnchorKey, TracePair>();
  for (const e of sorted) {
    if (e.kind !== "step") continue;
    const key = anchorKey(e.file, e.line);
    const existing = pairs.get(key);
    if (e.status === "enter") {
      if (!existing) pairs.set(key, { enter: e, terminal: null });
      // ignore duplicate enter — keep the first
    } else if (
      e.status === "done" ||
      e.status === "error" ||
      e.status === "skip"
    ) {
      if (existing && !existing.terminal) {
        existing.terminal = e;
      }
    }
  }
  return pairs;
}

function statusFromPair(pair: TracePair): AnalyzedStatus {
  if (!pair.terminal) return "incomplete";
  if (pair.terminal.status === "done") return "done";
  if (pair.terminal.status === "error") return "error";
  if (pair.terminal.status === "skip") return "skip";
  return "incomplete";
}

function durationFromPair(pair: TracePair): number | undefined {
  if (!pair.terminal) return undefined;
  const start = Date.parse(pair.enter.ts);
  const end = Date.parse(pair.terminal.ts);
  if (Number.isNaN(start) || Number.isNaN(end)) return undefined;
  return Math.max(0, end - start);
}

/** Pull bullet text from the workflow markdown file at `line` (1-indexed). */
function bulletTextFromWorkflow(
  workflowText: string | null,
  line: number,
): string {
  if (!workflowText) return `(line ${line})`;
  const lines = workflowText.split("\n");
  const raw = lines[line - 1] ?? "";
  // Trim leading bullet + whitespace; preserve inline content
  return raw.replace(/^\s*[-*]\s*/, "").trim() || `(line ${line})`;
}

function buildSteps(
  trace: WorkflowReportEntry[],
  analysis: AnalysisRecord[],
  workflowText: string | null,
): StepViewModel[] {
  const tracePairs = pairTraceEvents(trace);
  const analysisByAnchor = new Map<AnchorKey, AnalysisRecord>();
  for (const rec of analysis) {
    analysisByAnchor.set(anchorKey(rec.anchor.file, rec.anchor.line), rec);
  }

  // Union of anchors from both sources — analysis may surface anchors that
  // trace has no events for (e.g. incomplete) and vice versa.
  const allKeys = new Set<AnchorKey>([
    ...tracePairs.keys(),
    ...analysisByAnchor.keys(),
  ]);

  const steps: StepViewModel[] = [];
  for (const key of allKeys) {
    const pair = tracePairs.get(key);
    const ana = analysisByAnchor.get(key);
    const file = pair?.enter.file ?? ana?.anchor.file ?? "";
    const line = pair?.enter.line ?? ana?.anchor.line ?? 0;

    // Prefer analysis's structured status; fall back to trace pair.
    const status: AnalyzedStatus = ana?.trace.status ?? (pair ? statusFromPair(pair) : "incomplete");
    const duration_ms = ana?.trace.duration_ms ?? (pair ? durationFromPair(pair) : undefined);
    const detail = ana?.trace.detail ?? pair?.terminal?.detail ?? pair?.enter.detail ?? undefined;
    const step_text =
      ana?.step_text ?? bulletTextFromWorkflow(workflowText, line);

    steps.push({
      file,
      line,
      step_text,
      status,
      duration_ms: duration_ms ?? undefined,
      detail: detail ?? undefined,
      tool_calls: ana?.transcript_span?.tool_calls,
      issues: ana?.issues ?? [],
      recommendation: ana?.recommendation ?? undefined,
    });
  }

  // Stable order: by line ascending, then by file as a tiebreaker for sub-workflow events.
  steps.sort((a, b) => a.line - b.line || a.file.localeCompare(b.file));
  return steps;
}

function buildSummary(steps: StepViewModel[]): RunSummary {
  let cleanCount = 0;
  let warnCount = 0;
  let errorCount = 0;
  let pendingCount = 0;
  let totalDurationMs = 0;
  for (const s of steps) {
    if (s.duration_ms) totalDurationMs += s.duration_ms;
    if (s.status === "done") {
      if (s.issues.length === 0) cleanCount += 1;
      else warnCount += 1;
    } else if (s.status === "error") {
      errorCount += 1;
    } else {
      pendingCount += 1;
    }
  }
  return {
    cleanCount,
    warnCount,
    errorCount,
    pendingCount,
    totalDurationMs,
    total: steps.length,
  };
}

/** Split markdown content at the first `## Steps` heading. Header is everything before it. */
function splitWorkflowMarkdown(text: string | null): string {
  if (!text) return "";
  const idx = text.search(/^##\s+Steps\b/m);
  if (idx === -1) return text;
  return text.slice(0, idx).trim();
}

// ─── Hook ───────────────────────────────────────────────────────────────────

export interface WorkflowTraceDataInput {
  /** Resolve via AgenticProcess entity (preferred for production). */
  processId?: string | null;
  /**
   * Absolute filesystem path to the run's output folder
   * (`<record_dir>/execution/output/`). Used by the dev preview page's
   * path mode when the entity layer isn't reachable.
   */
  outputFolderPath?: string | null;
}

export function useWorkflowTraceData(
  input: WorkflowTraceDataInput,
): WorkflowTraceViewModel {
  const { processId = null, outputFolderPath = null } = input;

  const procTypeId = useMemo(
    () => (processId ? new TypeId(AgenticProcess.type, processId) : null),
    [processId],
  );
  const { data: process } = useEntity<AgenticProcess>(procTypeId);

  const { computeNode } = useAgentContext();
  const fsTypeId = computeNode?.typeId ?? null;

  // Construct refs from whichever source is available — entity or path.
  const traceRef = useMemo(() => {
    if (process?.output_folder) return process.output_folder.child("workflow.trace.jsonl");
    if (outputFolderPath && fsTypeId) {
      return new FSRef(
        `${outputFolderPath.replace(/\/$/, "")}/workflow.trace.jsonl`.replace(/^\//, ""),
        fsTypeId,
      );
    }
    return null;
  }, [process?.output_folder?.path, outputFolderPath, fsTypeId]);

  const analysisRef = useMemo(() => {
    if (process?.output_folder) return process.output_folder.child("workflow.analysis.jsonl");
    if (outputFolderPath && fsTypeId) {
      return new FSRef(
        `${outputFolderPath.replace(/\/$/, "")}/workflow.analysis.jsonl`.replace(/^\//, ""),
        fsTypeId,
      );
    }
    return null;
  }, [process?.output_folder?.path, outputFolderPath, fsTypeId]);

  const trace = useJsonlFile<WorkflowReportEntry>(traceRef);
  const analysis = useJsonlFile<AnalysisRecord>(analysisRef);

  const workflowFile = useMemo<string | null>(() => {
    if (analysis.records.length > 0) return analysis.records[0].anchor.file;
    if (trace.records.length > 0) return trace.records[0].file;
    return null;
  }, [analysis.records, trace.records]);

  const workflowFsRef = useMemo(() => {
    if (!workflowFile || !fsTypeId) return null;
    return new FSRef(workflowFile.replace(/^\//, ""), fsTypeId);
  }, [workflowFile, fsTypeId]);

  const workflowFile_text = useTextFile(workflowFsRef);

  const viewModel = useMemo<WorkflowTraceViewModel>(() => {
    const steps = buildSteps(
      trace.records,
      analysis.records,
      workflowFile_text.text,
    );
    const summary = buildSummary(steps);
    const header = splitWorkflowMarkdown(workflowFile_text.text);

    let notice: string | undefined;
    if (trace.found && !analysis.found) {
      notice = "Analysis not available yet — step issues will appear once it completes.";
    } else if (!trace.found && !analysis.found && !workflowFile_text.found) {
      notice = undefined; // nothing to show; surfaced via empty state below
    }

    let error: string | undefined;
    if (procTypeId !== null && !process) {
      error = undefined; // still loading via entity
    } else if (!trace.found && !analysis.found) {
      error = "No trace or analysis files found for this run.";
    }

    const isLoading =
      (procTypeId !== null && !process && !outputFolderPath) ||
      trace.isLoading ||
      analysis.isLoading ||
      workflowFile_text.isLoading;

    return {
      workflowFile: workflowFile ?? "",
      fullText: workflowFile_text.text ?? "",
      header,
      steps,
      summary,
      isLoading,
      hasTrace: trace.found,
      hasAnalysis: analysis.found,
      notice,
      error,
    };
  }, [
    process,
    procTypeId,
    outputFolderPath,
    trace.records,
    trace.found,
    trace.isLoading,
    analysis.records,
    analysis.found,
    analysis.isLoading,
    workflowFile,
    workflowFile_text.text,
    workflowFile_text.found,
    workflowFile_text.isLoading,
  ]);

  return viewModel;
}
