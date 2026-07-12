import { useEffect, useRef, useState } from 'react';
import { getGitStatus } from '@src/lib/git-status-cache';

export interface GitShareGate {
  /** True while status is still loading (Share stays disabled to be safe). */
  loading: boolean;
  /** True when the checkout is dirty or has unpushed commits — block Share. */
  blocked: boolean;
  /** Uncommitted/untracked file count. */
  dirtyFiles: number;
  /** Commits ahead of the upstream (unpushed). */
  unpushed: number;
}

const CLEAN: GitShareGate = { loading: false, blocked: false, dirtyFiles: 0, unpushed: 0 };

/**
 * Gate a git-transfer share on a clean, pushed local checkout. A git share
 * ships only the GitOrigin (branch + head commit) and the receiver clones from
 * the remote, so uncommitted or unpushed work would silently not travel — or a
 * pinned head commit that isn't on the remote would break the receiver's clone.
 * We PREVENT the share (not warn) until the repo is clean and pushed; the footer
 * git push button is the unblock.
 *
 * ``gate`` is undefined for non-git shares → never blocked. Re-checks whenever
 * ``gate``/``enabled`` change (e.g. the dialog reopens).
 */
export function useGitShareGate(
  gate: { computeNodeId: string; workdir: string } | undefined,
  enabled: boolean,
): GitShareGate {
  const [state, setState] = useState<GitShareGate>(CLEAN);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    if (!enabled || !gate) {
      setState(CLEAN);
      return () => {
        mountedRef.current = false;
      };
    }
    setState((s) => ({ ...s, loading: true }));
    void getGitStatus(gate.computeNodeId, gate.workdir).then((status) => {
      if (!mountedRef.current) return;
      // No repo / status error → nothing to gate on; allow the share.
      if (!status || status.error) {
        setState(CLEAN);
        return;
      }
      const dirtyFiles = status.files?.length ?? 0;
      const unpushed = status.ahead ?? 0;
      setState({ loading: false, blocked: dirtyFiles > 0 || unpushed > 0, dirtyFiles, unpushed });
    });
    return () => {
      mountedRef.current = false;
    };
  }, [gate, enabled]);

  return state;
}
