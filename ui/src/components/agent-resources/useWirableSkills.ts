import { useMemo } from 'react';
import { dataContext, Skill, type AssetDescriptor } from '@sdk';
import { useProcessAssets } from '@src/components/asset-manager';

/** Stable identity — an inline literal would rebuild the hook's fetch each render. */
const SKILL_TYPES = [Skill.type] as const;

/**
 * Skills a process started in this project would see, via the staging read
 * `useProcessAssets(null, …)` — rows arrive already attributed to a `source`.
 * NOT a type listing: `/graph/skill` has no location filter (77 rows, 10 real).
 */
export function useWirableSkills(): { descriptors: AssetDescriptor[]; isLoading: boolean } {
  // The pane rides the active project; `useProcessAssets` falls back to
  // `@local` on its own when there is none, so this stays undefined rather
  // than guessing an id here.
  const projectId = dataContext.project?.typeId?.id;

  const options = useMemo(
    () => ({ projectId, types: SKILL_TYPES as readonly string[] }),
    [projectId],
  );

  const { descriptors, isLoading } = useProcessAssets(null, options);

  return { descriptors, isLoading };
}
