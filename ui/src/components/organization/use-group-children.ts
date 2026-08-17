import { TypeId } from '@sdk';
import { useMemo } from 'react';

import { useMembers } from '@src/hooks/use-members';
import { isGroupMember } from '@src/components/organization/member-list';

/**
 * The teams nested inside an organization or team.
 *
 * There is no separate "children" endpoint to call: a team that belongs to a
 * parent already comes back in the parent's OWN roster as a first-class row of
 * ``type: "team"`` (the hub lists group principals alongside people). So the tree
 * and the member table are literally the same fetch, and expanding a node costs
 * nothing the detail panel was not going to load anyway.
 *
 * ``enabled`` keeps it lazy — a collapsed node fetches nothing, which is what
 * makes an unbounded hierarchy affordable to draw.
 */
export function useGroupChildren(nodeType: string, nodeId: string, enabled: boolean) {
  const typeId = useMemo(() => (enabled ? new TypeId(nodeType, nodeId) : null), [enabled, nodeType, nodeId]);
  const { members, ready } = useMembers(typeId);

  const children = useMemo(
    () =>
      (members || [])
        .filter((m) => isGroupMember(m as never))
        .map((m) => {
          const row = m as unknown as { id: string; name?: string; user_name?: string };
          return { type: 'team', id: row.id, label: row.name || row.user_name || 'Team' };
        }),
    [members],
  );

  return { children, loading: enabled && !ready };
}
