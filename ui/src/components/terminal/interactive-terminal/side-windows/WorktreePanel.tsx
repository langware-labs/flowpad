import { FolderGit2, GitMerge, Loader2 } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@src/components/ui/button';
import { AgenticProcess, ComputeNode } from '@sdk';
import { useContext } from '@sdk/react/hooks';
import { useDockNavigation } from '@src/navigation/useDockNavigation';

const COMMIT_MERGE_PROMPT = 'Please commit all of my changes, if any (commit only, do not push or open a PR), then merge to parent branch if there are no merge conflicts. If merged successfuly (without any merge conflicts) - exit worktree.';

interface WorktreePanelProps {
  process: AgenticProcess;
  onInjectPrompt?: (text: string) => void;
}

export const WorktreePanel: React.FC<WorktreePanelProps> = ({ process, onInjectPrompt }) => {
  const { computeNode } : { computeNode: ComputeNode } = useContext();

  const workdir = process.workdir;
  const [isGitRepoHasCommit, setIsGitRepoHasCommit] = useState(false);
  const isGitWorktree = Boolean(process.context_data?.worktree);

  const { navigation } = useDockNavigation();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [awaitingCompletion, setAwaitingCompletion] = useState(false);
  const wasActiveRef = useRef(false);

  // Close the tab once Claude finishes the commit-merge task
  useEffect(() => {
    if (!awaitingCompletion) return;
    const isActive = process.is_active ?? false;
    if (isActive) {
      wasActiveRef.current = true;
    } else if (wasActiveRef.current) {
      wasActiveRef.current = false;
      setAwaitingCompletion(false);
      navigation.openDock(null);
    }
  }, [awaitingCompletion, process.is_active, navigation]);

  // Detect worktree type from git
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
        const isRepoHasCommit = await computeNode.git(workdir).hasCommit();
        if (cancelled) return;
        setIsGitRepoHasCommit(isRepoHasCommit);
      } catch {
        if (cancelled) return;
        setIsGitRepoHasCommit(false);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [computeNode, workdir]);

  const handleOpenInWorktree = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const ctx = process.context_data ?? {};
      const { process: newProcess } = await AgenticProcess.spawn(
        {
          worktree: true,
          workdir,
          permissionMode: (ctx.permission_mode as 'bypassPermissions' | 'askUser') ?? 'askUser',
        },
        { visible: true },
      );
      navigation.openDock(newProcess.dockPointer);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to open worktree');
    } finally {
      setLoading(false);
    }
  }, [process, navigation, workdir]);

  const handleCommitMergeClick = useCallback(() => {
    setError(null);
    if (onInjectPrompt) {
      onInjectPrompt(COMMIT_MERGE_PROMPT);
      wasActiveRef.current = false;
      setAwaitingCompletion(true);
    }
  }, [onInjectPrompt]);

  if (isGitWorktree) {
    return (
      <div className="flex flex-1 flex-col p-4">
        <div className="flex items-center gap-2 border-b pb-3">
          <FolderGit2 className="h-4 w-4 text-amber-500" />
          <span className="text-sm font-medium">Worktree Session</span>
          <span className="ml-auto rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-semibold text-amber-500">
            ACTIVE
          </span>
        </div>
        <div className="mt-4 flex flex-col gap-3">
          <p className="text-xs text-muted-foreground leading-relaxed">
            This session is running in an isolated git worktree. When you are done, commit
            your changes and merge them back into the parent branch.
          </p>
          <Button
            variant="default"
            size="sm"
            className="mt-2 w-full"
            onClick={handleCommitMergeClick}
            disabled={awaitingCompletion}
          >
            {awaitingCompletion ? (
              <Loader2 className="mr-2 h-3 w-3 animate-spin" />
            ) : (
              <GitMerge className="mr-2 h-3 w-3" />
            )}
            {awaitingCompletion ? 'Working…' : 'Commit & Merge'}
          </Button>
          {awaitingCompletion && (
            <p className="text-xs text-muted-foreground">
              Claude is working on it. Tab will close when done.
            </p>
          )}
          {error && (
            <p className="text-xs text-destructive">{error}</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col p-4">
      <div className="flex items-center gap-2 border-b pb-3">
        <FolderGit2 className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">Worktree</span>
      </div>
      <div className="mt-4 flex flex-col gap-3">
        <p className="text-xs text-muted-foreground leading-relaxed">
          Open a new session in an isolated git worktree. This keeps your main working tree
          clean while the agent makes changes on a separate branch.
        </p>
        <Button
          variant="outline"
          size="sm"
          className="mt-2 w-full"
          onClick={() => { void handleOpenInWorktree(); }}
          disabled={loading || !isGitRepoHasCommit}
        >
          {loading ? (
            <Loader2 className="mr-2 h-3 w-3 animate-spin" />
          ) : (
            <FolderGit2 className="mr-2 h-3 w-3" />
          )}
          Open in Worktree
        </Button>
        {!loading && !isGitRepoHasCommit && (
          <p className="text-xs text-muted-foreground">
            Requires a git repository with at least one commit.
          </p>
        )}
        {error && (
          <p className="text-xs text-destructive">{error}</p>
        )}
      </div>
    </div>
  );
};
