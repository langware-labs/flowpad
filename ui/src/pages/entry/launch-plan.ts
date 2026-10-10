import { ViewType } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { DeepLinkAction } from '@src/navigation/inbound-link';

/**
 * The boundary between a launch's USE stage and its SETUP stage: what the machine opens.
 *
 * USE (the hub's `/launch` page) ends by handing a machine this plan — the desktop through
 * the `flowpad://` deep link, a cloud box through `open-service?next=` — and SETUP (the app's
 * `action=launch` handler) starts from it. Both legs land on the SAME path, so the setup code
 * is one.
 *
 * - `target` — the project that is OPENED: the session's working directory, the chip, git.
 *   A hub project id, or (a `?repo=` link) a repository to clone.
 * - `controllerId` — the `controller` project acting on the target, when there is one. It
 *   is checked out beside the target and never attached to it.
 * - `agentId` — the face, when the link named one. Otherwise the controller's home page
 *   decides, then the target's.
 */
export interface LaunchPlan {
  target: { projectId: string } | { repo: string; branch?: string };
  controllerId?: string;
  agentId?: string;
}

/** Every query key a launch path carries — read together, scrubbed together. */
export const LAUNCH_PARAMS = ['action', 'target', 'target_repo', 'target_branch', 'controller', 'agent'] as const;

export const LAUNCH_ACTION = DeepLinkAction.LAUNCH;

/** The app path a machine opens for `plan`: `/dock/home?action=launch&…`. */
export function launchPlanToPath(plan: LaunchPlan): string {
  const params = new URLSearchParams({ action: LAUNCH_ACTION });
  if ('projectId' in plan.target) {
    params.set('target', plan.target.projectId);
  } else {
    params.set('target_repo', plan.target.repo);
    if (plan.target.branch) params.set('target_branch', plan.target.branch);
  }
  if (plan.controllerId) params.set('controller', plan.controllerId);
  if (plan.agentId) params.set('agent', plan.agentId);
  return `${new DockPointer(ViewType.HOME).toUrl()}?${params.toString()}`;
}

/** The plan a launch path carries, or null when it is not a (complete) launch link. */
export function launchPlanFromParams(params: URLSearchParams): LaunchPlan | null {
  if (params.get('action') !== LAUNCH_ACTION) return null;
  const projectId = params.get('target')?.trim();
  const repo = params.get('target_repo')?.trim();
  // Exactly one target: a link naming both was built wrong, and guessing would open the wrong one.
  if (!projectId === !repo) return null;
  const target = projectId
    ? { projectId }
    : { repo: repo!, ...(params.get('target_branch') ? { branch: params.get('target_branch')! } : {}) };
  const controllerId = params.get('controller')?.trim() || undefined;
  const agentId = params.get('agent')?.trim() || undefined;
  return { target, ...(controllerId ? { controllerId } : {}), ...(agentId ? { agentId } : {}) };
}
