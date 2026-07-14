import { useEffect, useRef, useState } from 'react';
import { ActionInfo, dataManager, type TypeId } from '@sdk';

/**
 * Backend-owned Git-sharing eligibility for one asset. The Share dialog's Git
 * toggle reads this before it lets the sender pick Git mode — the frontend never
 * shells git; the backend (``git_share_preflight`` action) is authoritative and
 * packing revalidates the same conditions.
 */
export interface GitSharePreflight {
  /** True while the check is in flight (the toggle can't be enabled yet). */
  loading: boolean;
  /** True when the asset can be shared by its Git origin. */
  available: boolean;
  /** Human-readable, actionable reason when not available (else null). */
  reason: string | null;
  /** Stable machine code for the state (tests / branching). */
  code: string | null;
}

interface PreflightResponse {
  available: boolean;
  reason: string | null;
  code: string | null;
  git_origin: Record<string, unknown> | null;
}

const IDLE: GitSharePreflight = { loading: false, available: false, reason: null, code: null };
const FAILED: GitSharePreflight = {
  loading: false,
  available: false,
  reason: 'Could not check Git eligibility.',
  code: 'status-failure',
};

/**
 * Resolve whether ``ref`` (an asset TypeId) is Git-shareable. Re-checks whenever
 * ``ref``/``enabled`` change (e.g. the dialog reopens). ``ref`` undefined → idle
 * (non-git-capable sources never render the toggle).
 */
export function useGitSharePreflight(
  ref: TypeId | undefined,
  enabled: boolean,
): GitSharePreflight {
  const [state, setState] = useState<GitSharePreflight>(IDLE);
  const mountedRef = useRef(true);

  const refKey = ref ? ref.toString() : '';
  useEffect(() => {
    mountedRef.current = true;
    if (!enabled || !ref) {
      setState(IDLE);
      return () => {
        mountedRef.current = false;
      };
    }
    setState((s) => ({ ...s, loading: true }));
    const action = new ActionInfo('git_share_preflight', ref.type, ref.id, 'GET');
    void dataManager
      .callAction<unknown, PreflightResponse>(action)
      .then((res) => {
        if (!mountedRef.current) return;
        if (!res) {
          setState(FAILED);
          return;
        }
        setState({
          loading: false,
          available: !!res.available,
          reason: res.reason ?? null,
          code: res.code ?? null,
        });
      })
      .catch(() => {
        if (mountedRef.current) setState(FAILED);
      });
    return () => {
      mountedRef.current = false;
    };
    // refKey stands in for ref identity (a fresh TypeId object each render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refKey, enabled]);

  return state;
}
