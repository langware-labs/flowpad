import { useCallback, useEffect, useRef, useState } from 'react';
import { ActionInfo, dataManager, type GitOrigin, type TypeId } from '@sdk';

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
  /**
   * The repo this asset comes from, when one could be derived — present even
   * when `available` is false (a dirty tree still has an origin). Null only
   * when there is genuinely no repo/remote to name.
   */
  origin: GitOrigin | null;
  /**
   * True once the backend has answered for the current ref. IDLE and "available"
   * both carry `code: null`, so callers that branch on the code need this to
   * tell "not asked yet" from "asked, and it's fine".
   */
  answered: boolean;
  /**
   * Re-run the check once, now. For callers that just CHANGED the thing being
   * checked (committed, pushed, set up a repo) — the answer is stale the moment
   * they succeed. Event-driven: call it when a remediation settles, never on a
   * timer.
   */
  refetch: () => void;
}

interface PreflightResponse {
  available: boolean;
  reason: string | null;
  code: string | null;
  git_origin: Record<string, unknown> | null;
}

/**
 * The one parse seam for the backend's `git_origin` payload. Returns the shared
 * `GitOrigin` model rather than a local mirror of it, so a new backend field is
 * added in one place (the model) instead of here as well.
 */
function toOrigin(raw: Record<string, unknown> | null | undefined): GitOrigin | null {
  if (!raw) return null;
  const { provider, owner, name, branch, head_commit, rel_path } = raw as Record<
    string,
    string | null | undefined
  >;
  if (!provider || !owner || !name) return null;
  return {
    kind: 'git',
    provider,
    owner,
    name,
    branch: branch ?? '',
    head_commit: head_commit ?? null,
    rel_path: rel_path ?? '.',
  };
}

type PreflightState = Omit<GitSharePreflight, 'refetch'>;

/**
 * Live preflight subscribers, keyed by the ref they are asking about.
 *
 * Git state is FILESYSTEM state, so no entity update announces it — a wizard
 * that gives a project a remote leaves every mounted consumer of this hook
 * holding a stale answer, and there are seven of them (the project chip, the
 * cloud-link button, both share surfaces, the deploy checklist, the share gate,
 * the asset git link). `refetch` only ever helped the ONE component that also
 * owned the remediation. This is the channel for the rest: whoever CHANGED the
 * git state says so, and everyone looking at it asks again.
 */
const subscribers = new Map<string, Set<() => void>>();

/**
 * Tell every mounted preflight for `ref` to ask the backend again — call it
 * after something changed git state (a repo was created, a remote added, a
 * merge pushed). Omit `ref` to refresh all of them, which is the honest default
 * for a wizard that may have touched a folder shared by several refs.
 *
 * Event-driven by contract: call it when a remediation SETTLES, never on a timer.
 */
export function invalidateGitPreflight(ref?: TypeId | string): void {
  const key = ref ? ref.toString() : null;
  const targets = key === null ? [...subscribers.values()] : [subscribers.get(key)];
  for (const set of targets) set?.forEach((fn) => fn());
}

const IDLE: PreflightState = {
  loading: false,
  available: false,
  reason: null,
  code: null,
  origin: null,
  answered: false,
};
const FAILED: PreflightState = {
  loading: false,
  available: false,
  reason: 'Could not check Git eligibility.',
  code: 'status-failure',
  origin: null,
  answered: true,
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
  const [state, setState] = useState<PreflightState>(IDLE);
  const [nonce, setNonce] = useState(0);
  const mountedRef = useRef(true);
  const refetch = useCallback(() => setNonce((n) => n + 1), []);

  const refKey = ref ? ref.toString() : '';

  // Subscribe to the shared invalidation channel for this ref.
  useEffect(() => {
    if (!enabled || !refKey) return;
    const set = subscribers.get(refKey) ?? new Set<() => void>();
    subscribers.set(refKey, set);
    set.add(refetch);
    return () => {
      set.delete(refetch);
      if (set.size === 0) subscribers.delete(refKey);
    };
  }, [refKey, enabled, refetch]);
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
          origin: toOrigin(res.git_origin),
          answered: true,
        });
      })
      .catch(() => {
        if (mountedRef.current) setState(FAILED);
      });
    return () => {
      mountedRef.current = false;
    };
    // refKey stands in for ref identity (a fresh TypeId object each render);
    // nonce re-runs the check on an explicit `refetch()`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refKey, enabled, nonce]);

  return { ...state, refetch };
}
