import { useCallback, useEffect, useMemo, useState } from 'react';
import { APIEntity, getMembers, type Participant, type TypeId } from '@sdk';
import { useEntity } from '@src/hooks/entity-hooks';

/** Module-level stable empty result so callers' equality checks (and any
 *  downstream useMemo deps) don't churn while the entity is still loading. */
const EMPTY_MEMBERS: readonly Participant[] = Object.freeze([]);

/** Module-level in-flight promise cache keyed by typeId.toString() so two
 *  consumers (e.g. ConversationView + MembersAvatarStack) mounting against
 *  the same conversation share the single `getMembers` round-trip instead
 *  of double-fetching. The entry is evicted once the promise settles. */
const _inFlight = new Map<string, Promise<Participant[]>>();

function _sharedGetMembers(typeId: TypeId): Promise<Participant[]> {
  const key = typeId.toString();
  const existing = _inFlight.get(key);
  if (existing) return existing;
  const promise = getMembers(typeId).finally(() => {
    if (_inFlight.get(key) === promise) _inFlight.delete(key);
  });
  _inFlight.set(key, promise);
  return promise;
}

export interface UseMembersResult {
  /** Members + roles. Sourced from the local entity cache, then refreshed
   *  on mount via the generic ``members`` action (which the local server
   *  reflects to the hub when ``entity.remote=true``). */
  members: Participant[];
  /** True while the on-mount refresh is in flight. */
  loading: boolean;
  /** True once the hub fetch has resolved at least once for this typeId
   *  (success OR failure — both leave `loading=false` and prove the roster
   *  is no longer "unknown"). Distinct from `members.length > 0` which
   *  can't tell "empty roster" from "fetch hasn't returned yet". */
  ready: boolean;
  /** Last fetch error, or null. ``members`` still falls through to the
   *  entity cache on failure so the UI degrades gracefully. */
  error: Error | null;
  /** Re-fetch via ``getMembers``. Caller uses this after actions that may
   *  have changed membership (invite, leave, role change). */
  refresh: () => Promise<void>;
  /** Invite a new member by email. Delegates to the entity's existing
   *  ``share(recipients=[email])`` path — the same one every other invite
   *  flow uses — then refreshes the members list. The recipient only shows
   *  up in ``members`` after they accept + join hub-side. */
  addMember: (email: string) => Promise<void>;
  /** Remove a member by user id. OWNER ONLY — the hub rejects non-owner (and
   *  owner-self) callers with 403, which throws here. Refreshes after. */
  removeMember: (userId: string) => Promise<void>;
}

/**
 * Generic members hook — works on any entity TypeId.
 *
 * Reads the initial member list from the locally-cached entity. On mount,
 * fires a single ``getMembers`` call to refresh from the canonical source
 * (the hub, when the entity is remote). No interval, no focus auto-refresh.
 * Multiple consumers for the same typeId share an in-flight fetch.
 */
export function useMembers(typeId: TypeId | null): UseMembersResult {
  const { data: entity } = useEntity<APIEntity<any>>(typeId);
  const [refreshed, setRefreshed] = useState<Participant[] | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<Error | null>(null);

  const refresh = useCallback(async () => {
    if (!typeId) return;
    setLoading(true);
    try {
      const fresh = await _sharedGetMembers(typeId);
      setRefreshed(fresh);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setLoading(false);
    }
  }, [typeId]);

  // Cancel-on-unmount + cancel-on-typeId-change: a late-arriving response
  // for typeId A must NOT call setRefreshed against typeId B (cross-tenant
  // roster bleed). The cancelled flag closes over the effect run, so the
  // setter no-ops once the cleanup ran.
  useEffect(() => {
    if (!typeId) {
      setRefreshed(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    _sharedGetMembers(typeId)
      .then((fresh) => {
        if (cancelled) return;
        setRefreshed(fresh);
        setError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e : new Error(String(e)));
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [typeId]);

  const addMember = useCallback(
    async (email: string) => {
      const trimmed = email.trim();
      if (!trimmed) return;
      if (!entity) throw new Error('useMembers: entity not loaded; cannot invite');
      await entity.share([trimmed]);
      await refresh();
    },
    [entity, refresh],
  );

  // Remove a member by user id. OWNER ONLY — the hub returns 403 for a
  // non-owner caller (or owner-self), which propagates as a thrown error here;
  // callers should surface it. Refreshes the roster after so the removed user
  // drops out of the list.
  const removeMember = useCallback(
    async (userId: string) => {
      const trimmed = userId.trim();
      if (!trimmed) return;
      if (!entity) throw new Error('useMembers: entity not loaded; cannot remove');
      await (entity as any).removeMember(trimmed);
      await refresh();
    },
    [entity, refresh],
  );

  // Prefer the freshly-fetched list; fall back to whatever the entity cache
  // has. Entities without a ``participants`` field surface as the shared
  // EMPTY_MEMBERS constant so the array identity is stable.
  const cached: Participant[] = (entity as any)?.participants ?? (EMPTY_MEMBERS as Participant[]);
  const members = refreshed ?? cached;
  // `ready` is "the hub has answered for this typeId at least once" — both
  // success and explicit failure count, so a sustained outage still unblocks
  // UI that gates on rosterReady (e.g. the unresolved-sender alert label)
  // instead of stalling on loading forever.
  const ready = useMemo(
    () => refreshed !== null || error !== null,
    [refreshed, error],
  );

  return { members, loading, ready, error, refresh, addMember, removeMember };
}
