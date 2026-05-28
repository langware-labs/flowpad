import { useCallback, useEffect, useState } from 'react';
import { APIEntity, getMembers, type Participant, type TypeId } from '@sdk';
import { useEntity } from '@src/hooks/entity-hooks';

export interface UseMembersResult {
  /** Members + roles. Sourced from the local entity cache, then refreshed
   *  on mount via the generic ``members`` action (which the local server
   *  reflects to the hub when ``entity.remote=true``). */
  members: Participant[];
  /** True while the on-mount refresh is in flight. */
  loading: boolean;
  /** Re-fetch via ``getMembers``. Caller uses this after actions that may
   *  have changed membership (invite, leave, role change). */
  refresh: () => Promise<void>;
  /** Invite a new member by email. Delegates to the entity's existing
   *  ``share(recipients=[email])`` path — the same one every other invite
   *  flow uses — then refreshes the members list. The recipient only shows
   *  up in ``members`` after they accept + join hub-side. */
  addMember: (email: string) => Promise<void>;
}

/**
 * Generic members hook — works on any entity TypeId.
 *
 * Reads the initial member list from the locally-cached entity. On mount,
 * fires a single ``getMembers`` call to refresh from the canonical source
 * (the hub, when the entity is remote). No interval, no focus auto-refresh.
 */
export function useMembers(typeId: TypeId | null): UseMembersResult {
  const { data: entity } = useEntity<APIEntity<any>>(typeId);
  const [refreshed, setRefreshed] = useState<Participant[] | null>(null);
  const [loading, setLoading] = useState<boolean>(false);

  const refresh = useCallback(async () => {
    if (!typeId) return;
    setLoading(true);
    try {
      const fresh = await getMembers(typeId);
      setRefreshed(fresh);
    } finally {
      setLoading(false);
    }
  }, [typeId]);

  useEffect(() => {
    if (!typeId) return;
    void refresh();
  }, [typeId, refresh]);

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

  // Prefer the freshly-fetched list; fall back to whatever the entity cache
  // has. Entities without a ``participants`` field surface as ``[]``.
  const cached: Participant[] = (entity as any)?.participants ?? [];
  const members = refreshed ?? cached;

  return { members, loading, refresh, addMember };
}
