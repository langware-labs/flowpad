import { useCallback, useEffect, useMemo, useState } from 'react';
import { APIEntity, getMembers, type Participant, type TypeId, type AnyEntity } from '@sdk';
import { useEntity } from '@src/hooks/entity-hooks';
import {
  useMembershipAvailability,
  type MembershipReason,
} from '@src/hooks/use-membership-availability';

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
  /** The entity itself, already resolved here for the roster — exposed so
   *  callers needing it (e.g. to publish before minting an invite link) don't
   *  mount a second ``useEntity`` for the same typeId. */
  entity: AnyEntity | null | undefined;
  /** Members + roles. Sourced from the local entity cache, then refreshed
   *  on mount via the generic ``members`` action (which the local server
   *  reflects to the hub when ``entity.remote=true``). */
  members: Participant[];
  /** True once the hub fetch has resolved at least once for this typeId
   *  (success OR failure — both leave `loading=false` and prove the roster
   *  is no longer "unknown"), OR membership is unavailable (nothing to wait
   *  for). Distinct from `members.length > 0` which can't tell "empty roster"
   *  from "fetch hasn't returned yet". */
  ready: boolean;
  /** Last fetch error, or null. ``members`` still falls through to the
   *  entity cache on failure so the UI degrades gracefully. */
  error: Error | null;
  /** True while a refresh is in flight over an already-shown cache — the header
   *  shows "updating…". */
  updating: boolean;
  /** True when signed in but the last refresh FAILED (hub unreachable): the UI
   *  shows the cached roster + "can't update — showing last synced". Never a
   *  sign-in prompt (the user is already authenticated). */
  stale: boolean;
  /** False when membership can't be used on this client (not signed in, or Local
   *  mode). Surfaces such that every members surface can disable + branch. */
  available: boolean;
  /** Why membership is/ isn't available — drives sign-in vs Local-mode copy. */
  reason: MembershipReason;
  /** Re-fetch via ``getMembers``. Caller uses this after actions that may
   *  have changed membership (invite, leave, role change). */
  refresh: () => Promise<void>;
  /** Invite one or more members by email in a single ``share`` round-trip —
   *  the same path every other invite flow uses. De-dupes + drops blanks
   *  first; recipients only appear in ``members`` after they accept + join
   *  hub-side. */
  addMembers: (emails: string[]) => Promise<void>;
  /** Remove a member by user id. OWNER ONLY — the hub rejects non-owner (and
   *  owner-self) callers with 403, which throws here. Refreshes after. */
  removeMember: (userId: string) => Promise<void>;
  /** Change a member's role. Gated hub-side by the role-grant chokepoint
   *  (``can_assign``: assign strictly below your rank, on a member strictly
   *  below your rank, never self/owner) — denials throw (403). ``role`` is a
   *  lowercase policy role (``admin``/``editor``/``member``/``reader``).
   *  Refreshes the roster after so the new role shows immediately. */
  setRole: (userId: string, role: string) => Promise<void>;
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
  const { data: entity } = useEntity<AnyEntity>(typeId);
  const { available, reason } = useMembershipAvailability();
  const [refreshed, setRefreshed] = useState<Participant[] | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<Error | null>(null);

  const refresh = useCallback(async () => {
    // Membership is 100% hub-driven — with no hub there is nothing to refresh.
    if (!typeId || !available) return;
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
  }, [typeId, available]);

  // Cancel-on-unmount + cancel-on-typeId-change: a late-arriving response
  // for typeId A must NOT call setRefreshed against typeId B (cross-tenant
  // roster bleed). The cancelled flag closes over the effect run, so the
  // setter no-ops once the cleanup ran.
  useEffect(() => {
    // Skip the fetch entirely when there's no typeId or no hub — don't even
    // touch the shared in-flight map. An unavailable state clears any prior
    // fetch so a sign-out immediately drops to the disabled surface.
    if (!typeId || !available) {
      setRefreshed(null);
      setError(null);
      setLoading(false);
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
  }, [typeId, available]);

  const addMembers = useCallback(
    async (emails: string[]) => {
      const cleaned = Array.from(new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean)));
      if (!cleaned.length) return;
      if (!entity) throw new Error('useMembers: entity not loaded; cannot invite');
      await entity.share(cleaned);
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

  // Change a member's role by user id. The hub's ``can_assign`` gate rejects
  // out-of-ceiling callers with 403, which propagates as a thrown error here;
  // callers should surface it. Refreshes the roster after so the row shows
  // the new role without a manual reload.
  const setRole = useCallback(
    async (userId: string, role: string) => {
      const trimmedId = userId.trim();
      const trimmedRole = role.trim().toLowerCase();
      if (!trimmedId || !trimmedRole) return;
      if (!entity) throw new Error('useMembers: entity not loaded; cannot change role');
      await (entity as any).setMemberRole(trimmedId, trimmedRole);
      await refresh();
    },
    [entity, refresh],
  );

  // Stale-while-revalidate: the HUB answer wins the moment it arrives. Until
  // then, paint the locally-cached roster (``Entity.members``, kept warm by the
  // fanout for conversations and by the last reflect for everything else) so the
  // list shows instantly. On a refresh failure we keep the cache (stale) rather
  // than blanking. This is the inverse of the old "cache wins when non-empty"
  // rule — a roster the hub has since emptied now correctly clears.
  const cached = (entity as any)?.members as Participant[] | undefined;
  const cachedMembers = Array.isArray(cached) ? cached : null;
  const members: Participant[] = refreshed ?? cachedMembers ?? (EMPTY_MEMBERS as Participant[]);
  // "updating…" while a refresh runs over an already-shown cache (the internal
  // ``loading`` state is exposed under the SWR-flavored name).
  const updating = loading;
  // Signed in but the refresh failed → show cached + "can't update".
  const stale = available && error !== null;
  // `ready` is "the hub has answered at least once" (success OR failure), OR
  // membership is unavailable (nothing to wait for) — so UI gating on
  // rosterReady never stalls on a logged-out / offline surface.
  const ready = useMemo(
    () => refreshed !== null || error !== null || !available,
    [refreshed, error, available],
  );

  return {
    entity,
    members,
    ready,
    error,
    updating,
    stale,
    available,
    reason,
    refresh,
    addMembers,
    removeMember,
    setRole,
  };
}
