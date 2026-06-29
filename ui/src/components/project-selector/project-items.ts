import type { ProjectListItem } from '@sdk';
import { getProjectDisplayName } from '@src/hooks/use-claude-projects';
import type { ProjectSelectorItem } from './ProjectSelector';
import { canonicalPath } from './use-ensure-project';

/**
 * Map backend project-list rows (``useAllProjects`` / ``list_projects``) to
 * picker items. The item ``id`` is the canonical cwd — the same key
 * `useEnsureProject` dedups on — so consumers can match selections and
 * ``excludeIds`` against canonicalized paths.
 */
export function projectListToSelectorItems(projects: ProjectListItem[]): ProjectSelectorItem[] {
  return projects
    .filter((p) => !!p.cwd)
    .map((p) => ({
      id: canonicalPath(p.cwd),
      name: getProjectDisplayName(p),
      path: p.cwd,
      modifiedAt: p.modified_at ?? null,
    }));
}
