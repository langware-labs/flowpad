import { useCallback, useEffect, useState } from 'react';
import { getAccess, setAccess, TypeId, type AccessRule, type ChildAccess } from '@sdk';
import { useMembershipAvailability, type MembershipReason } from '@src/hooks/use-membership-availability';

/** Stable identity so callers' equality checks don't churn while loading. */
const NO_RULES: AccessRule[] = [];

export interface UseAccessResult {
  /** The rules `parent` confers on `child`. Empty means inherit — the hub returns
   *  no rules for the `('*','*')` pass-through, so the list IS the mode. */
  rules: AccessRule[];
  /** True once the fetch resolved (success OR failure), or access is unavailable. */
  ready: boolean;
  /** True while a request is in flight. */
  updating: boolean;
  /** Last error, or null. A 404 here means "not a parent". */
  error: Error | null;
  /** False when membership features can't be used at all (signed out / Local mode). */
  available: boolean;
  reason: MembershipReason;
  refresh: () => void;
  /** Replace the rule set. An empty list restores inherit. Throws on refusal. */
  save: (rules: AccessRule[]) => Promise<void>;
}

/**
 * View and edit what ``parent`` confers on ``child``.
 *
 * Both ids are required: access is a property of the EDGE, not of either entity,
 * so there is nothing to read with only one. Pass nulls (no selection, or a node
 * with no parent) and the hook idles.
 */
export function useAccess(child: TypeId | null, parent: TypeId | null): UseAccessResult {
  const { available, reason } = useMembershipAvailability();
  const [access, setAccessState] = useState<ChildAccess | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [reloads, setReloads] = useState(0);

  // One primitive for both ids, so a re-render with structurally-equal-but-new
  // TypeId objects does not refetch.
  const key = child && parent ? `${child.type}-${child.id}|${parent.type}-${parent.id}` : null;

  useEffect(() => {
    if (!key || !child || !parent || !available) {
      setAccessState(null);
      setError(null);
      setLoading(false);
      return;
    }
    // ``cancelled`` guards against a slow response for a PREVIOUS selection
    // landing after the user clicked another node — that would show one edge's
    // rules under another edge's heading.
    let cancelled = false;
    setAccessState(null);
    setLoading(true);
    getAccess(child, parent)
      .then((next) => !cancelled && (setAccessState(next), setError(null)))
      .catch((err) => !cancelled && setError(err instanceof Error ? err : new Error(String(err))))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, available, reloads]);

  const save = useCallback(
    async (rules: AccessRule[]) => {
      if (!child || !parent) return;
      setLoading(true);
      try {
        setAccessState(await setAccess(child, parent, rules));
        setError(null);
      } finally {
        setLoading(false);
      }
    },
    [child, parent],
  );

  return {
    rules: access?.rules ?? NO_RULES,
    ready: access !== null || error !== null || !available,
    updating: loading,
    error,
    available,
    reason,
    refresh: useCallback(() => setReloads((n) => n + 1), []),
    save,
  };
}
