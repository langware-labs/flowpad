/**
 * Lazy per-run summary loader for the RunStrip chips.
 *
 * The full `useRunnerData` hook only computes summaries for the *selected*
 * runs (active + overlays). That leaves every other chip in the strip
 * defaulting to `verdict='unknown'`, which renders as `UNKNOWN` in the
 * hover tooltip even when the run is actually a clean pass/fail on disk.
 *
 * This hook is the lightweight sibling: for each AgenticProcess it reads
 * trace.jsonl + analysis.jsonl from `output_folder`, runs the same
 * reduceTrace + reduceAnalysis + mergeSteps + summarize chain, and
 * returns a Map keyed by processId. Transcript usage is intentionally
 * skipped — chips only need pass/fail/cost/duration, not per-step cost.
 *
 * Caching: keyed by `id + output_folder.path` so we don't refetch on
 * every render. Re-loads only when the run list changes or an
 * output_folder is repointed.
 */

import { useEffect, useMemo, useState } from 'react';
import { AgenticProcess, FSRef, dataContext } from '@sdk';

import {
  deriveVerdict,
  mergeSteps,
  summarize,
} from './reducers/mergeSteps';
import { extractStepLines } from './reducers/extractStepLines';
import { reduceAnalysis } from './reducers/reduceAnalysis';
import { reduceTrace } from './reducers/reduceTrace';
import type { RunSummary, RunViewModel } from './types';

export interface StripRunSummary {
  summary: RunSummary;
  verdict: RunViewModel['verdict'];
  durationSec?: number;
  costUsd?: number;
  hasTrace: boolean;
  hasAnalysis: boolean;
}

function durationSecFromTrace(trace: ReturnType<typeof reduceTrace>): number | undefined {
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

export function useStripRunSummaries(
  runs: AgenticProcess[],
  workflowSource: string,
): Map<string, StripRunSummary> {
  const [summaries, setSummaries] = useState<Map<string, StripRunSummary>>(
    () => new Map(),
  );
  const computeNodeId = dataContext.computeNodeTypeId;
  const stepLines = useMemo(() => extractStepLines(workflowSource), [workflowSource]);

  // Cache key reflects id + output_folder so a repointed folder forces a
  // re-load but a pure render-cycle doesn't.
  const cacheKey = useMemo(
    () =>
      runs
        .map((r) => `${r.id}@${r.output_folder?.path ?? '-'}`)
        .join(';') + '||' + workflowSource.length,
    [runs, workflowSource.length],
  );

  useEffect(() => {
    let cancelled = false;
    if (!computeNodeId || runs.length === 0 || !workflowSource) {
      setSummaries(new Map());
      return;
    }

    const safeRead = async (path: string | null): Promise<string> => {
      if (!path) return '';
      try {
        return await new FSRef(path, computeNodeId).read();
      } catch {
        return '';
      }
    };

    const loadOne = async (process: AgenticProcess): Promise<[string, StripRunSummary] | null> => {
      const out = process.output_folder?.path ?? null;
      if (!out) return null;
      const [trace, analysis] = await Promise.all([
        safeRead(`${out}/workflow.trace.jsonl`),
        safeRead(`${out}/workflow.analysis.jsonl`),
      ]);
      const hasTrace = trace.length > 0;
      const hasAnalysis = analysis.length > 0;
      // Transcript usage is skipped on purpose — strip chips don't need
      // per-step cost detail; the workflow.trace.jsonl preserves enough.
      const tr = reduceTrace(trace, []);
      const an = reduceAnalysis(analysis, stepLines);
      const steps = mergeSteps(workflowSource, tr, an);
      const summary = summarize(steps);
      const verdict = deriveVerdict(summary);
      const durationSec = durationSecFromTrace(tr);
      const costUsd = summary.totalCostUsd;
      return [process.id, { summary, verdict, durationSec, costUsd, hasTrace, hasAnalysis }];
    };

    void Promise.all(runs.map(loadOne)).then((entries) => {
      if (cancelled) return;
      const next = new Map<string, StripRunSummary>();
      for (const entry of entries) {
        if (entry) next.set(entry[0], entry[1]);
      }
      setSummaries(next);
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey, computeNodeId]);

  return summaries;
}
