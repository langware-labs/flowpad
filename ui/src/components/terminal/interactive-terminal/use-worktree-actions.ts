/**
 * Git worktree actions for a session — the logic behind the two worktree rows
 * of the session actions menu.
 *
 * useCommitMerge: offered when the process is running inside a worktree.
 *   Injects a commit-and-merge prompt, then auto-navigates away once Claude
 *   finishes.
 *
 * useOpenInWorktree: spawns a new worktree session. Unavailable when the repo
 *   has no commits yet.
 */

import { AgenticProcess, isWorkerRunning } from '@sdk';
import type { ComputeNode } from '@sdk';
import { useContext } from '@sdk/react/hooks';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useCallback, useEffect, useRef, useState } from 'react';

const COMMIT_MERGE_PROMPT =
  'Please commit all of my changes, if any (commit only, do not push or open a PR), then merge to parent branch if there are no merge conflicts. If merged successfully (without any merge conflicts) - exit worktree.';

// ── useCommitMerge ─────────────────────────────────────────────────────────────

export interface CommitMergeAction {
  /** The process runs inside a worktree, so there is something to merge back. */
  available: boolean;
  /** The prompt was sent and Claude has not finished the task yet. */
  working: boolean;
  run: () => void;
}

export function useCommitMerge(process: AgenticProcess, onInjectPrompt: (text: string) => void): CommitMergeAction {
  const { navigation } = useDockNavigation();
  const [awaitingCompletion, setAwaitingCompletion] = useState(false);
  const wasActiveRef = useRef(false);

  // Auto-close the tab once Claude finishes the commit-merge task.
  // "Active" here means "worker is actively running a turn" — so we watch the
  // worker status transition out of a running state (WORKING/THINKING/TOOL_*).
  useEffect(() => {
    if (!awaitingCompletion) return;
    const workerBusy = isWorkerRunning(process.workerStatus);
    if (workerBusy) {
      wasActiveRef.current = true;
    } else if (wasActiveRef.current) {
      wasActiveRef.current = false;
      setAwaitingCompletion(false);
      navigation.openShellView();
    }
  }, [awaitingCompletion, process.workerStatus, navigation]);

  const run = useCallback(() => {
    onInjectPrompt(COMMIT_MERGE_PROMPT);
    wasActiveRef.current = false;
    setAwaitingCompletion(true);
  }, [onInjectPrompt]);

  return { available: !!process.cliOptions.worktree, working: awaitingCompletion, run };
}

// ── useOpenInWorktree ──────────────────────────────────────────────────────────

export interface OpenInWorktreeAction {
  /** The repo check, or the spawn, is in flight. */
  loading: boolean;
  /** The workdir is a git repository with at least one commit. */
  hasCommit: boolean;
  open: () => Promise<void>;
}

/**
 * `enabled` gates the repo check: it is a backend git call, so the menu asks
 * only once it is opened rather than for every session header on screen.
 */
export function useOpenInWorktree(process: AgenticProcess, { enabled }: { enabled: boolean }): OpenInWorktreeAction {
  const { computeNode } = useContext() as { computeNode: ComputeNode };
  const { navigation } = useDockNavigation();
  const workdir = process.workdir ?? undefined;

  const [loading, setLoading] = useState(true);
  const [hasCommit, setHasCommit] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    setLoading(true);
    if (!computeNode || !workdir) {
      setHasCommit(false);
      setLoading(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const result = await computeNode.git(workdir).hasCommit();
        if (!cancelled) setHasCommit(result);
      } catch {
        if (!cancelled) setHasCommit(false);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, computeNode, workdir]);

  const open = useCallback(async () => {
    setLoading(true);
    try {
      const { process: newProcess } = await AgenticProcess.spawn(
        {
          worktree: true,
          workdir,
          permissionMode: (process.cliOptions.permission_mode as 'bypassPermissions' | 'askUser') ?? 'askUser',
        },
        { visible: true },
      );
      navigation.openDock(newProcess.terminalDockPointer);
    } finally {
      setLoading(false);
    }
  }, [process, navigation, workdir]);

  return { loading, hasCommit, open };
}
