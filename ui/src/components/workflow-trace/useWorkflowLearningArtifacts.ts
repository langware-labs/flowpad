/**
 * useWorkflowLearningArtifacts — load memory.md, feedback.md, learning.log.md
 * and execution_log/<ts>/ summary from a workflow's record data folder.
 *
 * Phase 4 wrote these files; this hook makes them available to the viewer's
 * Memory / Feedback / History tabs (Phase 5).
 *
 * Greedy: any missing file is non-fatal; the corresponding tab simply won't
 * render content (or the History list will be empty).
 */

import { useEffect, useMemo, useState } from "react";
import { FSRef } from "@sdk";
import { useAgentContext } from "@src/components/agent-layout/agent-layout";

import type {
  FeedbackArtifact,
  HistoryEntry,
  LearningArtifacts,
  LearningLogArtifact,
  MemoryArtifact,
} from "./types";

/** Format MM_DD_YY__HH_MM_SS as "May 9 · 11:45:55". */
function prettyTimestamp(folder: string): string {
  const m = folder.match(/^(\d{2})_(\d{2})_(\d{2})__(\d{2})_(\d{2})_(\d{2})$/);
  if (!m) return folder;
  const [, mm, dd, , hh, mi, ss] = m;
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  const monthIdx = Math.max(0, Math.min(11, parseInt(mm, 10) - 1));
  return `${months[monthIdx]} ${parseInt(dd, 10)} · ${hh}:${mi}:${ss}`;
}

interface AnalysisRecordLike {
  trace?: { status?: string };
  issues?: { kind: string }[];
}

function summarizeArchive(records: AnalysisRecordLike[]): {
  cleanSteps: number;
  totalSteps: number;
  totalIssues: number;
  hasError: boolean;
} {
  let clean = 0;
  let issues = 0;
  let hasError = false;
  for (const r of records) {
    const status = r.trace?.status ?? "done";
    if (status === "error") hasError = true;
    const stepIssues = r.issues ?? [];
    issues += stepIssues.length;
    if (status === "done" && stepIssues.length === 0) clean += 1;
  }
  return {
    cleanSteps: clean,
    totalSteps: records.length,
    totalIssues: issues,
    hasError,
  };
}

export function useWorkflowLearningArtifacts(
  workflowDataDir: string | null | undefined,
  /** Path to the run currently displayed — used to mark the matching
   *  history row with `isCurrent: true`. */
  currentArchiveOrOutput: string | null | undefined,
): LearningArtifacts {
  const { computeNode } = useAgentContext();
  const fsTypeId = computeNode?.typeId ?? null;

  const [memory, setMemory] = useState<MemoryArtifact | undefined>(undefined);
  const [feedback, setFeedback] = useState<FeedbackArtifact | undefined>(undefined);
  const [log, setLog] = useState<LearningLogArtifact | undefined>(undefined);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!workflowDataDir || !fsTypeId) {
      setMemory(undefined);
      setFeedback(undefined);
      setLog(undefined);
      setHistory([]);
      return;
    }

    let cancelled = false;
    setIsLoading(true);

    const root = workflowDataDir.replace(/\/$/, "");
    const memoryRef = new FSRef(`${root}/memory.md`.replace(/^\//, ""), fsTypeId);
    const feedbackRef = new FSRef(`${root}/feedback.md`.replace(/^\//, ""), fsTypeId);
    const logRef = new FSRef(`${root}/learning.log.md`.replace(/^\//, ""), fsTypeId);
    const execLogRef = new FSRef(
      `${root}/execution_log`.replace(/^\//, ""),
      fsTypeId,
      "folder",
    );

    const loadOne = async <T,>(
      label: string,
      ref: FSRef,
      shape: (text: string) => T,
    ): Promise<T | undefined> => {
      try {
        const text = await ref.read();
        return shape(text);
      } catch (e) {
        // file missing — non-fatal
        return undefined;
      }
    };

    const run = async () => {
      const memoryPromise = loadOne("memory", memoryRef, (text) => ({
        content: text,
        bytes: new Blob([text]).size,
      }));
      const feedbackPromise = loadOne("feedback", feedbackRef, (text) => ({
        content: text,
        // We don't have an FS-stat for mtime in the TS SDK; use Date.now()
        // as a stand-in keyed by content hash. The "seen" marker stores the
        // content hash in localStorage so changes flip it.
        mtime: Date.now(),
      }));
      const logPromise = loadOne("log", logRef, (text) => {
        const entries = text.split("\n").filter((l) => l.startsWith("## ")).length;
        return { content: text, entryCount: entries };
      });

      // List execution_log/ children, summarize each archive's analysis.
      let historyEntries: HistoryEntry[] = [];
      try {
        const children = await execLogRef.ls();
        const archives = children
          .map((c) => {
            const name = c.path.split("/").pop() ?? "";
            return { ref: c, name };
          })
          .filter((a) => /^\d{2}_\d{2}_\d{2}__\d{2}_\d{2}_\d{2}$/.test(a.name))
          .sort((a, b) => b.name.localeCompare(a.name)); // newest first

        const summarized = await Promise.all(
          archives.map(async (a): Promise<HistoryEntry> => {
            const analysisRef = new FSRef(
              `${a.ref.path.replace(/\/$/, "")}/workflow.analysis.jsonl`.replace(/^\//, ""),
              fsTypeId,
            );
            let summary = {
              cleanSteps: -1,
              totalSteps: -1,
              totalIssues: -1,
              hasError: false,
            };
            try {
              const text = await analysisRef.read();
              const records = text
                .split("\n")
                .filter((l) => l.trim())
                .map((l) => JSON.parse(l) as AnalysisRecordLike);
              summary = summarizeArchive(records);
            } catch {
              /* analysis missing — leave as -1 */
            }
            const archiveDir = a.ref.path.startsWith("/")
              ? a.ref.path
              : `/${a.ref.path}`;
            const isCurrent = currentArchiveOrOutput
              ? currentArchiveOrOutput.replace(/\/$/, "") === archiveDir.replace(/\/$/, "")
              : false;
            return {
              timestamp: a.name,
              display: prettyTimestamp(a.name),
              archiveDir,
              ...summary,
              isCurrent,
            };
          }),
        );
        historyEntries = summarized;
      } catch {
        historyEntries = [];
      }

      const [m, f, lg] = await Promise.all([
        memoryPromise,
        feedbackPromise,
        logPromise,
      ]);

      if (cancelled) return;
      setMemory(m);
      // Drop empty feedback files — the learner only writes content on surrender.
      setFeedback(f && f.content.trim() ? f : undefined);
      setLog(lg);
      setHistory(historyEntries);
      setIsLoading(false);
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [workflowDataDir, fsTypeId, currentArchiveOrOutput]);

  return useMemo(
    () => ({
      workflowDataDir: workflowDataDir ?? undefined,
      memory,
      feedback,
      learningLog: log,
      history,
      isLoading,
    }),
    [workflowDataDir, memory, feedback, log, history, isLoading],
  );
}
