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
  const mountedRef = useRef(true);

  const fetchStatus = useCallback(async (force = false) => {
    if (!computeNodeId || !workdir) {
      setCount(null);
      setHasRepo(false);
      setBranch(null);
      return;
    }
    // Shared cache dedups the cross-tab mount burst; force on poll/refresh.
    const result = await getGitStatus(computeNodeId, workdir, { force });
    if (!mountedRef.current) return;
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
    mountedRef.current = true;
    void fetchStatus();
    const interval = setInterval(() => { void fetchStatus(true); }, POLL_MS);
    return () => {
      mountedRef.current = false;
      clearInterval(interval);
    };
  }, [fetchStatus]);

  const refresh = useCallback(() => {
    void fetchStatus(true);
  }, [fetchStatus]);

  return { count, hasRepo, branch, refresh };
}
