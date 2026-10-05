import { useCallback, useEffect, useRef, useState } from 'react';
import { fsManager, GitWorkdir } from '@sdk';
import { getGitStatus } from '@src/lib/git-status-cache';

export interface UseGitChangeCountResult {
  /** Total changed + untracked files, or null when unknown / no workdir. */
  count: number | null;
  /** Local commits not yet pushed (e.g. an auto-committed asset save). */
  ahead: number;
  /** Upstream commits not yet pulled — as of the last background fetch. */
  behind: number;
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
 * lightweight UI-driven poll every 10 minutes, plus whenever
 * any editor writes a file (``fsManager.onFileWritten`` — asset saves
 * are auto-committed). One ``fetchStatus`` powers all
 * triggers (switch / poll / write / explicit refresh) so there is no duplicate
 * status logic.
 *
 * ``behind`` needs the network, which ``status`` never touches: on mount,
 * project switch, poll and explicit refresh — not on every file write — a
 * background ``git fetch`` follows the status, and its answer moves
 * ``behind``. The pill never waits on it.
 */
export function useGitChangeCount(computeNodeId: string | null, workdir: string | null): UseGitChangeCountResult {
  const [count, setCount] = useState<number | null>(null);
  const [ahead, setAhead] = useState(0);
  const [behind, setBehind] = useState(0);
  const [hasRepo, setHasRepo] = useState(false);
  const [branch, setBranch] = useState<string | null>(null);
  // Only the latest request may write: after a project switch the previous
  // workdir's status can still land, and a slow repo lands last. Unmount bumps
  // it too, so nothing in flight writes into an unmounted hook.
  const latestRequestRef = useRef(0);
  // Same rule for the background fetch, on its own counter: a status landing
  // mid-fetch must not discard the fetch's fresher ``behind``.
  const latestFetchRef = useRef(0);

  const fetchStatus = useCallback(
    async (force = false) => {
      const request = ++latestRequestRef.current;
      if (!computeNodeId || !workdir) {
        setCount(null);
        setAhead(0);
        setBehind(0);
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
        setAhead(0);
        setBehind(0);
        setBranch(null);
      } else {
        setHasRepo(true);
        setCount(result.files?.length ?? 0);
        setAhead(result.ahead ?? 0);
        setBehind(result.behind ?? 0);
        setBranch(result.branch ?? null);
      }
    },
    [computeNodeId, workdir],
  );

  const fetchRemote = useCallback(async () => {
    const request = ++latestFetchRef.current;
    if (!computeNodeId || !workdir) return;
    const result = await new GitWorkdir(workdir, computeNodeId).fetch().catch(() => null);
    if (request !== latestFetchRef.current || !result || result.error) return;
    setBehind(result.behind ?? 0);
  }, [computeNodeId, workdir]);

  const checkAll = useCallback(
    async (force: boolean) => {
      await fetchStatus(force);
      void fetchRemote();
    },
    [fetchStatus, fetchRemote],
  );

  useEffect(() => {
    void checkAll(false);
    const interval = setInterval(() => {
      void checkAll(true);
    }, POLL_MS);
    // Every editor saves through fsManager, and a save to a git-tracked asset
    // is auto-committed server-side — so any write may have changed git state.
    const unsubscribeWrites = fsManager.onFileWritten(() => {
      void fetchStatus(true);
    });
    return () => {
      latestRequestRef.current++;
      latestFetchRef.current++;
      clearInterval(interval);
      unsubscribeWrites();
    };
  }, [fetchStatus, checkAll]);

  const refresh = useCallback(() => {
    void checkAll(true);
  }, [checkAll]);

  return { count, ahead, behind, hasRepo, branch, refresh };
}
