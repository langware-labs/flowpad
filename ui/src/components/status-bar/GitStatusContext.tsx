import { useGitChangeCount } from '@src/hooks/use-git-change-count';
import React, { createContext, useContext, useMemo } from 'react';

interface GitStatusContextValue {
  computeNodeId: string | null;
  workdir: string | null;
  count: number | null;
  hasRepo: boolean;
  branch: string | null;
  refresh: () => void;
}

const GitStatusContext = createContext<GitStatusContextValue | null>(null);

/**
 * Single shared git-status source for the footer. Both the pending-changes pill
 * and the push button read from this one instance, so a push (or the 10-minute
 * poll, or a project switch) refreshes them together — no second fetch, no
 * stale pill after a push.
 */
export const GitStatusProvider: React.FC<{
  computeNodeId: string | null;
  workdir: string | null;
  children: React.ReactNode;
}> = ({ computeNodeId, workdir, children }) => {
  const { count, hasRepo, branch, refresh } = useGitChangeCount(computeNodeId, workdir);
  const value = useMemo<GitStatusContextValue>(
    () => ({ computeNodeId, workdir, count, hasRepo, branch, refresh }),
    [computeNodeId, workdir, count, hasRepo, branch, refresh],
  );
  return <GitStatusContext.Provider value={value}>{children}</GitStatusContext.Provider>;
};

/** Read the shared footer git status. Returns null outside a provider. */
export function useGitStatus(): GitStatusContextValue | null {
  return useContext(GitStatusContext);
}
