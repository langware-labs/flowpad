import { type GitOrigin, PageId, ViewType } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';

/**
 * Where a project share's invitation lands: `/project/<id>`. Sent by the sharer
 * as the invitation's `callback_override` (flow_sdk `Project.share`), so the
 * landing is a property of the invitation rather than of whichever target the
 * hub picks — the same reason `sandboxShareLandingPath` exists.
 */
export function projectShareLandingPath(projectId: string): string {
  return `/project/${encodeURIComponent(projectId)}`;
}

/** The project on the hub page: `/dock/hub/project/<id>`. */
export function hubProjectPath(projectId: string): string {
  return DockPointer.forProject(projectId).withPage(PageId.HUB).toUrl();
}

/**
 * The DESKTOP path "Open in FlowPad" hands over (as the deep link's `next`):
 * the `?action=open` home link `IncomingDeepLink` already reads. `setup_git` +
 * `git_origin` raise the clone dialog; `project_id` makes it materialize the
 * shared project this box already holds as a file-less row, in place, so the
 * recipient's project keeps the id the sharer's has.
 */
export function projectOpenTargetPath(project: { id: string; name: string; gitOrigin: GitOrigin }): string {
  const params = new URLSearchParams({
    action: 'open',
    setup_git: '1',
    project_id: project.id,
    git_origin: JSON.stringify(project.gitOrigin),
    title: project.name,
  });
  return `${new DockPointer(ViewType.HOME).toUrl()}?${params.toString()}`;
}
