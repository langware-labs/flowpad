import type { Project, ProjectListItem } from '@sdk';
import { getProjectDisplayName } from '@src/hooks/use-claude-projects';
import { projectRecencyMs } from '@src/lib/project-recency';
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
      recencyMs: projectRecencyMs(p),
    }));
}

/**
 * Map Project ENTITIES (``useProjects`` / the graph) to picker items.
 *
 * Sibling of {@link projectListToSelectorItems}, which maps the cwd-keyed
 * ``list_projects`` rows. Two sources, one item shape — kept together so a
 * picker gets the same recency ordering and display name whichever it reads.
 * Here the item ``id`` is the entity id, since that is what entity-scoped
 * consumers navigate and compare on.
 */
export function projectEntitiesToSelectorItems(projects: Project[] | undefined): ProjectSelectorItem[] {
  return (projects ?? []).map((p) => ({
    id: p.id,
    name: p.displayName,
    path: p.fs_storage_mount_path ?? '',
    modifiedAt: p.updated_date ?? null,
    recencyMs: projectRecencyMs({ last_active_at: p.last_active_at, modified_at: p.updated_date }),
  }));
}
