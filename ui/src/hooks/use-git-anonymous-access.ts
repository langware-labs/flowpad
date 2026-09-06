import { useEffect, useState } from 'react';
import { ActionInfo, dataManager, type TypeId } from '@sdk';

/**
 * Can a stranger clone the repository behind this asset?
 *
 * The receiving-end counterpart to {@link useGitSharePreflight}. Preflight asks
 * whether the SENDER may publish; this asks whether the people they publish to
 * will be able to read what lands. The two are independent: a private repo
 * passes every preflight gate and then fails to open for every recipient who
 * isn't a collaborator on it, because Flowpad grants Flowpad membership and
 * never GitHub access.
 *
 * Backend-owned (`git_anonymous_access`), for the same reason preflight is: the
 * frontend never shells git, and the probe deliberately runs with the caller's
 * own credential helpers switched off so the answer is about a stranger rather
 * than about this machine.
 */
export interface GitAnonymousAccess {
  /** True while the probe is in flight. */
  loading: boolean;
  /**
   * True when an anonymous `ls-remote` reached the repo, false when it was
   * refused, `null` when there is no repository to ask about (`code` says why)
   * or the check hasn't run yet.
   */
  public: boolean | null;
  /** `owner/name`, for naming the repo in the warning. Null when undetermined. */
  repo: string | null;
  /** Preflight's own vocabulary for "there is nothing to probe" (else null). */
  code: string | null;
  /** True once the backend has answered for the current ref. */
  answered: boolean;
}

interface AnonymousAccessResponse {
  public: boolean | null;
  repo: string | null;
  clone_url: string | null;
  code: string | null;
  reason: string | null;
}

const IDLE: GitAnonymousAccess = { loading: false, public: null, repo: null, code: null, answered: false };
// A probe we could not run is not a repo we may call public — the whole point of
// the check is to warn, so an unknown answer must not silently read as "fine".
const FAILED: GitAnonymousAccess = {
  loading: false,
  public: null,
  repo: null,
  code: 'status-failure',
  answered: true,
};

/**
 * Probe `ref`'s repository for anonymous readability. Re-runs whenever
 * `ref`/`enabled` change — event-driven only, never polled: repository
 * visibility changes on GitHub, not on a timer.
 */
export function useGitAnonymousAccess(ref: TypeId | undefined, enabled: boolean): GitAnonymousAccess {
  const [state, setState] = useState<GitAnonymousAccess>(IDLE);

  const refKey = ref ? ref.toString() : '';
  useEffect(() => {
    if (!enabled || !ref) {
      setState(IDLE);
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    const action = new ActionInfo('git_anonymous_access', ref.type, ref.id, 'GET');
    void dataManager
      .callAction<unknown, AnonymousAccessResponse>(action)
      .then((res) => {
        if (cancelled) return;
        if (!res) {
          setState(FAILED);
          return;
        }
        setState({
          loading: false,
          public: res.public ?? null,
          repo: res.repo ?? null,
          code: res.code ?? null,
          answered: true,
        });
      })
      .catch(() => {
        if (!cancelled) setState(FAILED);
      });
    return () => {
      cancelled = true;
    };
    // refKey stands in for ref identity (a fresh TypeId object each render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refKey, enabled]);

  return state;
}
