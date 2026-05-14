/**
 * Single data hook for the WorkflowRunnerView.
 *
 * Replaces the duplicated useWorkflowTraceData / useWorkflowLearningArtifacts
 * pair. Loads:
 *   - workflow markdown source (once per workflow)
 *   - per-selected-run: trace.jsonl, analysis.jsonl, transcript usage
 *
 * Selecting multiple runs (Phase 4 overlay) loads them in parallel.
 * Memory / learning.log / feedback wiring lands in Phase 5/7.
 *
 * No business logic in components — they receive a `WorkflowRunnerViewModel`.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  AgenticProcess,
  FSRef,
  Workflow,
  dataContext,
} from '@sdk';
import {
  parseClaudeTranscriptUsage,
  type UsageEntry,
} from '@sdk/transcript-analyzer';

import type {
  FeedbackArtifact,
  LearningLogArtifact,
  MemoryArtifact,
  RunViewModel,
  WorkflowRunnerViewModel,
} from './types';
import { reduceTrace } from './reducers/reduceTrace';
import { reduceAnalysis } from './reducers/reduceAnalysis';
import {
  deriveVerdict,
  mergeSteps,
  summarize,
} from './reducers/mergeSteps';
import { extractStepLines } from './reducers/extractStepLines';
import { deriveStepHistory } from './reducers/deriveStepHistory';
import { deriveAttention } from './reducers/deriveAttention';
import { reduceLearningLog } from './reducers/reduceLearningLog';

interface UseRunnerDataInput {
  workflow: Workflow;
  /** Newest-first list of runs. */
  runs: AgenticProcess[];
  /**
   * Run IDs the user selected, in display order. First id = active.
   * Empty array defers to runs[0].
   */
  selectedRunIds?: string[];
}

/** Read one FSRef text, defaulting to empty string on miss. */
function useFileText(path?: string | null): string {
  const [text, setText] = useState<string>('');
  const computeNodeId = dataContext.computeNodeTypeId;
  useEffect(() => {
    let cancelled = false;
    if (!path || !computeNodeId) {
      setText('');
      return;
    }
    const ref = new FSRef(path, computeNodeId);
    void ref
      .read()
      .then((t) => {
        if (!cancelled) setText(t);
      })
      .catch(() => {
        if (!cancelled) setText('');
      });
    return () => {
      cancelled = true;
    };
  }, [path, computeNodeId]);
  return text;
}

interface RunFiles {
  trace: string;
  analysis: string;
  transcript: string;
}

/**
 * Load trace+analysis+transcript for N selected runs in parallel.
 * Keyed by process.id so we don't refetch when only the selection ORDER
 * changes.
 */
function useRunFiles(selectedRuns: AgenticProcess[]): Map<string, RunFiles> {
  const [files, setFiles] = useState<Map<string, RunFiles>>(new Map());
  const computeNodeId = dataContext.computeNodeTypeId;
  const homeDir = dataContext.computeNode?.home_dir;

  // Build the cache key from id+output_folder path so we re-load when a
  // run's output_folder is repointed (rare but possible).
  const cacheKey = useMemo(
    () =>
      selectedRuns
        .map(
          (r) =>
            `${r.id}@${r.output_folder?.path ?? '-'}|${r.session_id ?? '-'}|${r.project_encoded_name ?? '-'}`,
        )
        .join(';'),
    [selectedRuns],
  );

  useEffect(() => {
    let cancelled = false;
    if (!computeNodeId) {
      setFiles(new Map());
      return;
    }
    const ids = selectedRuns.map((r) => r.id);

    const loadOne = async (process: AgenticProcess): Promise<[string, RunFiles]> => {
      const out = process.output_folder?.path ?? null;
      const tracePath = out ? `${out}/workflow.trace.jsonl` : null;
      const analysisPath = out ? `${out}/workflow.analysis.jsonl` : null;
      const sess = process.session_id ?? null;
      const proj = process.project_encoded_name ?? null;
      const transcriptPath =
        sess && proj && homeDir
          ? `${homeDir.replace(/\/$/, '')}/.claude/projects/${proj}/${sess}.jsonl`.replace(/^\//, '')
          : null;
      const safeRead = async (p: string | null): Promise<string> => {
        if (!p) return '';
        try {
          return await new FSRef(p, computeNodeId).read();
        } catch {
          return '';
        }
      };
      const [trace, analysis, transcript] = await Promise.all([
        safeRead(tracePath),
        safeRead(analysisPath),
        safeRead(transcriptPath),
      ]);
      return [process.id, { trace, analysis, transcript }];
    };

    void Promise.all(selectedRuns.map(loadOne)).then((entries) => {
      if (cancelled) return;
      // Preserve the original selection order in the resulting Map.
      const next = new Map<string, RunFiles>();
      for (const id of ids) {
        const found = entries.find(([eid]) => eid === id);
        if (found) next.set(id, found[1]);
      }
      setFiles(next);
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey, computeNodeId, homeDir]);

  return files;
}

function fmtRunLabel(process: AgenticProcess, index: number): string {
  const created = process.created_date;
  if (!created) return `Run #${index + 1}`;
  const d = created instanceof Date ? created : new Date(created);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `#${index + 1} · ${hh}:${mm}`;
}

function durationSec(trace: ReturnType<typeof reduceTrace>): number | undefined {
  if (trace.length === 0) return undefined;
  let firstEnter: number | undefined;
  let lastEnd: number | undefined;
  for (const t of trace) {
    if (t.startedAt) {
      const ms = new Date(t.startedAt).getTime();
      if (Number.isFinite(ms) && (firstEnter === undefined || ms < firstEnter)) firstEnter = ms;
    }
    if (t.endedAt) {
      const ms = new Date(t.endedAt).getTime();
      if (Number.isFinite(ms) && (lastEnd === undefined || ms > lastEnd)) lastEnd = ms;
    }
  }
  if (firstEnter === undefined || lastEnd === undefined) return undefined;
  return Math.max(0, (lastEnd - firstEnter) / 1000);
}

export function useRunnerData(input: UseRunnerDataInput): WorkflowRunnerViewModel {
  const { workflow, runs } = input;

  // Resolve selected runs from incoming IDs, falling back to [runs[0]] when
  // the URL hadn't been touched yet.
  const selectedRuns = useMemo(() => {
    const wantIds = input.selectedRunIds ?? [];
    if (wantIds.length === 0) {
      return runs[0] ? [runs[0]] : [];
    }
    const byId = new Map(runs.map((r) => [r.id, r] as const));
    return wantIds.map((id) => byId.get(id)).filter((r): r is AgenticProcess => !!r);
  }, [runs, input.selectedRunIds]);

  const docRef = workflow.doc;
  const source = useFileText(docRef?.path ?? null);
  const files = useRunFiles(selectedRuns);

  // Workflow-level data dir: <records_root>/workflow/workflow-@<id>/
  // Contains memory.md, learning.log.md, feedback.md. The full
  // Memory + PastAttempts wiring is Phase 7; here we just need feedback
  // for the AttentionBanner.
  const recordsRoot =
    (dataContext as unknown as { recordsRoot?: string | null }).recordsRoot ??
    dataContext.bootstrapInfo?.records_root;
  const workflowDataDir = recordsRoot
    ? `${recordsRoot}/workflow/workflow-@${workflow.id}`
    : null;
  const feedbackPath = workflowDataDir ? `${workflowDataDir}/feedback.md` : null;
  const feedbackText = useFileText(feedbackPath);
  const memoryPath = workflowDataDir ? `${workflowDataDir}/memory.md` : null;
  const memoryText = useFileText(memoryPath);
  const logPath = workflowDataDir ? `${workflowDataDir}/learning.log.md` : null;
  const logText = useFileText(logPath);

  const stepLines = useMemo(() => extractStepLines(source), [source]);

  const runVMs: RunViewModel[] = useMemo(() => {
    return selectedRuns.map((process, displayIndex) => {
      // Color index is stable across the full runs list — newest = 0,
      // next = 1, etc. — so the same run keeps the same color regardless
      // of selection order.
      const colorIndex = Math.max(0, runs.findIndex((r) => r.id === process.id));
      const f = files.get(process.id);
      const trace = reduceTrace(f?.trace ?? '', f ? parseUsage(f.transcript) : []);
      const analysis = reduceAnalysis(f?.analysis ?? '', stepLines);
      const steps = mergeSteps(source, trace, analysis);
      const summary = summarize(steps);
      return {
        processId: process.id,
        colorIndex,
        label: fmtRunLabel(process, displayIndex),
        rawStatus: (process.status as string | undefined) ?? undefined,
        verdict: deriveVerdict(summary),
        startedAt:
          process.created_date instanceof Date
            ? process.created_date.toISOString()
            : (process.created_date as string | undefined),
        durationSec: durationSec(trace),
        costUsd: process.total_cost_usd ?? undefined,
        steps,
        summary,
        hasTrace: (f?.trace ?? '').length > 0,
        hasAnalysis: (f?.analysis ?? '').length > 0,
      } satisfies RunViewModel;
    });
  }, [selectedRuns, files, source, stepLines, runs]);

  const stepHistory = useMemo(() => deriveStepHistory(runVMs, stepLines), [runVMs, stepLines]);

  const feedback: FeedbackArtifact | undefined = useMemo(() => {
    if (!feedbackText?.trim()) return undefined;
    return { content: feedbackText, mtime: Date.now() };
  }, [feedbackText]);

  const memory: MemoryArtifact | undefined = useMemo(() => {
    if (!memoryText?.trim()) return undefined;
    return { content: memoryText, bytes: new Blob([memoryText]).size };
  }, [memoryText]);

  const learningLog: LearningLogArtifact | undefined = useMemo(() => {
    if (!logText?.trim()) return undefined;
    return reduceLearningLog(logText);
  }, [logText]);

  const attentions = useMemo(
    () => deriveAttention(runVMs, feedback ?? null),
    [runVMs, feedback],
  );

  const header = useMemo(() => {
    const idx = source.indexOf('## Steps');
    return idx >= 0 ? source.slice(0, idx) : source;
  }, [source]);

  return {
    workflowFile: docRef?.path ?? '',
    fullText: source,
    header,
    runs: runVMs,
    stepHistory,
    learning: {
      workflowDataDir: workflowDataDir ?? undefined,
      memory,
      feedback,
      learningLog,
      history: [],
      isLoading: false,
    },
    attentions,
    isLoading: !source && runVMs.length === 0,
  };
}

/** Parse usage entries lazily once per transcript string. */
const _usageCache = new WeakMap<object, UsageEntry[]>();
function parseUsage(transcript: string): UsageEntry[] {
  if (!transcript) return [];
  // String objects can't be WeakMap keys; cheap re-parse is fine here because
  // reduceAnalysis/reduceTrace are memoized at the RunViewModel layer above.
  return parseClaudeTranscriptUsage(transcript);
}
