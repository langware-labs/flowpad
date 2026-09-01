import { useMemo } from 'react';
import { dataContext, Skill, type AssetDescriptor } from '@sdk';
import { useProcessAssets } from '@src/components/asset-manager';

/** Stable identity — an inline literal would rebuild the hook's fetch each render. */
const SKILL_TYPES = [Skill.type] as const;

/**
 * The skills an agent launched in this project would actually see.
 *
 * Delegates to `useProcessAssets(null, …)` — the asset-manager's staging read,
 * which asks `project/{id}/get-assets` for "what a NEW process started in this
 * project would discover, before any process exists". That is exactly this
 * pane's situation: an agent is a template, so there is no process to inspect.
 * Descriptors come back already attributed to a `source` (`user_dir`,
 * `project_dir`, `context_dir`, …), which is what the scope chip renders.
 *
 * Deliberately NOT a type listing. This hook used to call
 * `/graph/skill?include_system=true`, which has no location filter and returned
 * every skill indexed anywhere on the machine — 77 rows here, only 10 of them
 * genuinely global; the rest came from ten unrelated checkouts and from
 * flowpad-hub's test fixtures, because `default_roots()` walks the whole user
 * home. `useProcessAssets` carries the same warning for the same reason:
 *
 *   > NEVER list whole type corpora here: the previous implementation fetched
 *   > ALL agents + skills + specs + markdown docs (~3.3MB / 3-5s at ~3k docs).
 *
 * Filtering by `Skill.scope` is not an alternative either: `classify_path` only
 * distinguishes system/user/project from path-vs-home, so a skill in another
 * checkout's `.claude/skills` under the home directory is labelled `user`,
 * indistinguishable from a real global one.
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
