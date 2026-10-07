import type { Project, ProjectListItem } from '@sdk';

/**
 * The hub's own project list, shaped for the picker.
 *
 * The picker's rows come from the projects DISCOVERED on a compute node — a
 * machine's scan. A hub-only server has no such machine for most people, so a
 * member whose only access is a project shared with them saw "No projects
 * found" while the hub held it. Here the rows are the projects the hub itself
 * lists for the signed-in user: no folder (`cwd` stays null, a hub project
 * lives in git, not on a disk) and no session counts, which are scan data.
 *
 * App-managed projects stay out unless `includeSystem` asks for them, the same
 * rule the scan-backed list applies.
 */
export function hubProjectListItems(
  projects: readonly Project[] | undefined,
  includeSystem: boolean,
): ProjectListItem[] {
  return (projects ?? [])
    .filter((p) => includeSystem || !p.hidden)
    .map((p) => ({
      id: p.id,
      name: p.name ?? '',
      encoded_name: '',
      cwd: null,
      session_count: 0,
      modified_at: p.updated_date ? String(p.updated_date) : null,
      hidden: p.hidden,
    }));
}
