import { useCallback, useEffect, useMemo, useState } from 'react';
import { GitWorkdir, type GitPushResult, type GitStatus } from '@sdk';

/**
 * useGitFolderStatus — the "not yet on the remote" view of a git workdir.
 *
 * Combines `git-ops/status` (pending working-tree changes) with
 * `git-ops/unpushed-files` (files touched by commits ahead of @{u}) into one
 * set of ABSOLUTE paths, so a file browser can highlight anything the remote
 * doesn't have yet. `push()` runs the backend's greedy publish
 * (stage-all → commit → pull --rebase → push) and refreshes.
 *
 * Pass `workdir = null` to disable (non-git folders) — everything goes empty.
 */
export function useGitFolderStatus(workdir: string | null, computeNodeId: string = '@local') {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [unpushedCommitted, setUnpushedCommitted] = useState<string[]>([]);
  const [pushing, setPushing] = useState(false);

  const git = useMemo(() => (workdir ? new GitWorkdir(workdir, computeNodeId) : null), [workdir, computeNodeId]);

  const refresh = useCallback(async () => {
    if (!git) {
      setStatus(null);
      setUnpushedCommitted([]);
      return;
    }
    try {
      const [s, u] = await Promise.all([git.getStatus(), git.unpushedFiles()]);
      setStatus(s);
      setUnpushedCommitted(u);
    } catch {
      // Status is a decoration — a failed probe (node offline, dir gone)
      // degrades to "no highlight", never to an error surface.
      setStatus(null);
      setUnpushedCommitted([]);
    }
  }, [git]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Absolute paths of everything the remote doesn't have yet. */
  const unpushedAbsPaths = useMemo(() => {
    const set = new Set<string>();
    if (!workdir) return set;
    const base = workdir.replace(/\/+$/, '');
    for (const f of status?.files ?? []) {
      // Porcelain renames arrive as "old -> new" — the working-tree file is the new name.
      const rel = f.path.includes(' -> ') ? f.path.split(' -> ').pop()! : f.path;
      if (rel) set.add(`${base}/${rel}`);
    }
    for (const rel of unpushedCommitted) {
      if (rel) set.add(`${base}/${rel}`);
    }
    return set;
  }, [workdir, status, unpushedCommitted]);

  const hasUnpushed = unpushedAbsPaths.size > 0 || (status?.ahead ?? 0) > 0;

  /** True when `path` itself is unpushed, or (for a dir) contains an unpushed file. */
  const isPathUnpushed = useCallback(
    (path: string, isDir: boolean): boolean => {
      const clean = path.replace(/\/+$/, '');
      if (unpushedAbsPaths.has(clean)) return true;
      if (!isDir) return false;
      const prefix = `${clean}/`;
      for (const p of unpushedAbsPaths) {
        if (p.startsWith(prefix)) return true;
      }
      return false;
    },
    [unpushedAbsPaths],
  );

  const push = useCallback(async (): Promise<GitPushResult | null> => {
    if (!git) return null;
    setPushing(true);
    try {
      const result = await git.push();
      await refresh();
      return result;
    } finally {
      setPushing(false);
    }
  }, [git, refresh]);

  return { status, unpushedAbsPaths, hasUnpushed, isPathUnpushed, refresh, push, pushing } as const;
}
