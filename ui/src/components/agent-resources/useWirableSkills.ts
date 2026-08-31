import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient, dataManager, Skill } from '@sdk';
import { useEntityOps } from '@sdk/react/hooks';

const QUERY_KEY = ['agent-resources', 'skills'] as const;

/** Module-scope: `useEntityOps` keys its effect on the array's IDENTITY, so an
 *  inline literal would unsubscribe and resubscribe on every single render. */
const WATCHED_TYPES = [Skill.type];

/**
 * Every skill that can be wired into an agent, hydrated as real `Skill`
 * entities so a row has `typeId`, `name` and `description` without a second
 * lookup.
 *
 * Deliberately the raw graph route with `include_system=true`, not
 * `useEntitiesQuery` and not `/search`:
 *
 *  - `useEntitiesQuery` omits the flag, so it silently drops every SDK-shipped
 *    system skill (this is why `SkillsAgentsPanel` reaches for the same route).
 *  - `/search` + `projectScope` drops them too, for a different reason: the
 *    backend applies the scope filter BEFORE the system filter, and system
 *    skills carry the system project's id — so scoping to your project excludes
 *    them however `include_system` is set.
 *
 * A skill the user cannot see is a skill they cannot attach, so both misses are
 * disqualifying here.
 */
export function useWirableSkills(): { skills: Skill[]; isLoading: boolean } {
  const queryClient = useQueryClient();

  const { data = [], isLoading } = useQuery<Skill[]>({
    queryKey: QUERY_KEY,
    queryFn: async () => {
      const rows: Partial<Skill>[] = (await apiClient.get<Partial<Skill>[]>('/graph/skill?include_system=true')) ?? [];
      return rows
        .map((row: Partial<Skill>) => dataManager.updateEntityFromJson<Skill>({ ...row, type: Skill.type }))
        .sort((a: Skill, b: Skill) => (a.name ?? '').localeCompare(b.name ?? ''));
    },
    staleTime: 30_000,
  });

  // A skill authored while this pane is open must appear in it. Invalidate on
  // skill ops rather than polling — no interval, no refetch budget.
  const onSkillOp = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
  }, [queryClient]);
  useEntityOps(WATCHED_TYPES, onSkillOp as never);

  return { skills: data, isLoading };
}
