import { useCallback, useEffect, useRef, useState } from 'react';
import { getGitStatus } from '@src/lib/git-status-cache';

export interface UseGitChangeCountResult {
  /** Total changed + untracked files, or null when unknown / no workdir. */
  count: number | null;
  /** True when the workdir is a git repo (no status error). */
  hasRepo: boolean;
  /** Current branch name, or null. */
  branch: string | null;
  /** Re-fetch the status (e.g. after a push or closing the diff modal). */
  refresh: () => void;
}

/** UI-driven background poll interval for the footer git status. */
const POLL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Single source for the footer git status (pending-change count + branch) of a
 * project's working tree. Mirrors ``GitPanel.fetchStatus`` (the same
 * ``git-ops status`` action). Fetches on mount and whenever
 * ``computeNodeId``/``workdir`` change — i.e. on project switch — plus a
 * lightweight UI-driven poll every 10 minutes. One ``fetchStatus`` powers all
 * three triggers (switch / poll / explicit refresh) so there is no duplicate
 * status logic.
 */
export function useGitChangeCount(
  computeNodeId: string | null,
  workdir: string | null,
): UseGitChangeCountResult {
  const [count, setCount] = useState<number | null>(null);
  const [hasRepo, setHasRepo] = useState(false);
  const [branch, setBranch] = useState<string | null>(null);
  // Only the latest request may write: after a project switch the previous
  // workdir's status can still land, and a slow repo lands last. Unmount bumps
  // it too, so nothing in flight writes into an unmounted hook.
  const latestRequestRef = useRef(0);

  const fetchStatus = useCallback(async (force = false) => {
    const request = ++latestRequestRef.current;
    if (!computeNodeId || !workdir) {
      setCount(null);
      setHasRepo(false);
      setBranch(null);
      return;
    }
    // Shared cache dedups the cross-tab mount burst; force on poll/refresh.
    const result = await getGitStatus(computeNodeId, workdir, { force });
    if (request !== latestRequestRef.current) return;
    if (!result || result.error) {
      setHasRepo(false);
      setCount(null);
      setBranch(null);
    } else {
      setHasRepo(true);
      setCount(result.files?.length ?? 0);
      setBranch(result.branch ?? null);
    }
  }, [computeNodeId, workdir]);

  useEffect(() => {
    void fetchStatus();
    const interval = setInterval(() => { void fetchStatus(true); }, POLL_MS);
    return () => {
      latestRequestRef.current++;
      clearInterval(interval);
    };
  }, [fetchStatus]);

  const refresh = useCallback(() => {
    void fetchStatus(true);
  }, [fetchStatus]);

  return { count, hasRepo, branch, refresh };
}
