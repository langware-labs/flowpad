/**
 * WorktreeButtons — toolbar controls for git worktree workflows.
 *
 * CommitMergeButton: prominent button shown when the process is running inside
 *   a worktree. Injects a commit-and-merge prompt, then auto-navigates away
 *   once Claude finishes.
 *
 * OpenInWorktreeButton: icon button that spawns a new worktree session.
 *   Disabled when the current process is already a worktree or the repo has
 *   no commits yet.
 */

import { AgenticProcess, isWorkerRunning } from '@sdk';
import type { ComputeNode } from '@sdk';
import { useContext } from '@sdk/react/hooks';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { FolderGit2, GitMerge, Loader2 } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

const COMMIT_MERGE_PROMPT =
  'Please commit all of my changes, if any (commit only, do not push or open a PR), then merge to parent branch if there are no merge conflicts. If merged successfully (without any merge conflicts) - exit worktree.';

// ── CommitMergeButton ──────────────────────────────────────────────────────────

interface CommitMergeButtonProps {
  process: AgenticProcess;
  onInjectPrompt: (text: string) => void;
}

export function CommitMergeButton({ process, onInjectPrompt }: CommitMergeButtonProps) {
  const { t } = useLingui();
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

  const handleCommitMergeClick = useCallback(() => {
    onInjectPrompt(COMMIT_MERGE_PROMPT);
    wasActiveRef.current = false;
    setAwaitingCompletion(true);
  }, [onInjectPrompt]);

  if (!process.cliOptions.worktree)
    return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          className={`inline-flex h-7 items-center gap-1.5 rounded px-2 text-xs font-medium transition-colors ${
            awaitingCompletion
              ? 'cursor-not-allowed bg-primary/20 text-primary opacity-70'
              : 'cursor-pointer bg-primary text-primary-foreground hover:bg-primary/90'
          }`}
          disabled={awaitingCompletion}
          onClick={handleCommitMergeClick}
          aria-label={t`Commit & Merge`}
        >
          {awaitingCompletion ? <Loader2 className="h-3 w-3 animate-spin" /> : <GitMerge className="h-3 w-3" />}
          {awaitingCompletion ? t`Working…` : t`Commit & Merge`}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-[240px] text-xs">
        <Trans>Commit all changes and merge back to the parent branch. Claude will exit the worktree when done.</Trans>
      </TooltipContent>
    </Tooltip>
  );
}

// ── OpenInWorktreeButton ───────────────────────────────────────────────────────

interface OpenInWorktreeButtonProps {
  process: AgenticProcess;
}

export function OpenInWorktreeButton({ process }: OpenInWorktreeButtonProps) {
  const { t } = useLingui();
  const { computeNode } = useContext() as { computeNode: ComputeNode };
  const { navigation } = useDockNavigation();
  const workdir = process.workdir ?? undefined;

  const [loading, setLoading] = useState(true);
  const [isGitRepoHasCommit, setIsGitRepoHasCommit] = useState(false);

  useEffect(() => {
    setLoading(true);
    if (!computeNode || !workdir) {
      setIsGitRepoHasCommit(false);
      setLoading(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const hasCommit = await computeNode.git(workdir).hasCommit();
        if (!cancelled) setIsGitRepoHasCommit(hasCommit);
      } catch {
        if (!cancelled) setIsGitRepoHasCommit(false);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [computeNode, workdir]);

  const handleOpenWorktreeClick = useCallback(async () => {
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

  const disabled = loading || !isGitRepoHasCommit;

  const tooltip = isGitRepoHasCommit
      ? t`Open a new isolated git worktree session on a separate branch`
      : t`Requires a git repository with at least one commit`;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          className={`inline-flex h-7 w-7 items-center justify-center rounded transition-colors ${
            disabled ? 'cursor-not-allowed opacity-40 text-muted-foreground' : 'cursor-pointer hover:bg-accent text-muted-foreground'
          }`}
          disabled={disabled}
          onClick={() => void handleOpenWorktreeClick()}
          aria-label={t`Open in Worktree`}
        >
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FolderGit2 className="h-3.5 w-3.5" />}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-[220px] text-xs">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
}
