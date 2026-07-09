import { useCallback, useEffect, useRef, useState } from 'react';
import { GitWorkdir, type GitRevision, type GitRevisionList } from '@sdk';

export interface UseAssetRevisionStatusResult {
  /** Past revisions of this file, newest first. */
  revisions: GitRevision[];
  /** Current (HEAD) version of this asset, or null. */
  version: number | null;
  /** Local commits to this file not yet pushed (the header "pending" count). */
  unpushed: number;
  /** True when the file lives in a git repo with history. */
  hasRepo: boolean;
  /** Re-fetch (e.g. after a save, restore, or push). */
  refresh: () => void;
}

/**
 * Per-asset git revision status — the file-scoped analogue of
 * ``use-git-change-count``. Calls the ``git-ops file-revisions`` sub-path for a
 * single file and exposes its history, current version, and unpushed count.
 * Re-fetches on mount, when the file/workdir changes, and whenever
 * ``reloadSignal`` changes (the editor's ``lastSync`` after an autosave).
 */
export function useAssetRevisionStatus(
  computeNodeId: string | null,
  workdir: string | null,
  file: string | null,
  reloadSignal?: unknown,
): UseAssetRevisionStatusResult {
  const [data, setData] = useState<GitRevisionList>({ revisions: [], version: null, unpushed: 0 });
  const mountedRef = useRef(true);

  const fetchStatus = useCallback(async () => {
    const empty = { revisions: [], version: null, unpushed: 0 };
    if (!computeNodeId || !workdir || !file) {
      setData(empty);
      return;
    }
    try {
      const result: GitRevisionList = await new GitWorkdir(workdir, computeNodeId).fileRevisions(file);
      if (!mountedRef.current) return;
      setData({
        revisions: result?.revisions ?? [],
        version: result?.version ?? null,
        unpushed: result?.unpushed ?? 0,
      });
    } catch {
      if (mountedRef.current) setData(empty);
    }
  }, [computeNodeId, workdir, file]);

  useEffect(() => {
    mountedRef.current = true;
    void fetchStatus();
    return () => {
      mountedRef.current = false;
    };
  }, [fetchStatus, reloadSignal]);

  // hasRepo is derived — a file with history is one that's in a repo.
  return { ...data, hasRepo: data.revisions.length > 0, refresh: fetchStatus };
}
