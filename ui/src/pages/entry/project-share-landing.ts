import { PageId, ViewType } from '@sdk';
import type { ProjectOrigin } from '@sdk/models/FSOrigin';
import { DockPointer } from '@src/navigation/DockPointer';

/** The BROWSER target: this project on the hub page, `/dock/hub/project/<id>`. */
export function projectHubPath(projectId: string): string {
  return DockPointer.forProject(projectId).withPage(PageId.HUB).toUrl();
}

/**
 * The DESKTOP path "Open in FlowPad" hands over (as the deep link's `next`): the
 * `?action=open` home link `IncomingDeepLink` reads. `setup_git` + `git_origin`
 * raise the clone dialog; `project_id` makes it materialize the shared project
 * the box already holds as a file-less row, in place, keeping the id both ends
 * share.
 */
export function projectOpenTargetPath(project: { id: string; name: string; gitOrigin: ProjectOrigin }): string {
  const params = new URLSearchParams({
    action: 'open',
    setup_git: '1',
    project_id: project.id,
    git_origin: JSON.stringify(project.gitOrigin),
    title: project.name,
  });
  return `${new DockPointer(ViewType.HOME).toUrl()}?${params.toString()}`;
}
