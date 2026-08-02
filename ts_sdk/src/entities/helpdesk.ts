import { dataManager } from '../APIEntity';
import { ActionInfo } from '../models/ActionInfo';

/**
 * Help-desk PORTAL lifecycle — the local checkout of the desk's help content.
 *
 * Distinct from the ticket queue (see `conversation.ts`
 * `startHelpdeskTicket` / `listHelpdeskTickets`): a desk answers tickets on the
 * hub, and separately publishes a portal repo that requesters clone and browse
 * locally. A desk may have either, or both.
 *
 * These map 1:1 onto the steps of the load flow so the UI can render one
 * checklist row per call. All routing goes through `ActionInfo` — the backend
 * base URL never appears here.
 */

export interface HelpdeskEnsureResult {
  /**
   * False when this desk publishes no portal repo — a VALID configuration (a
   * desk can answer tickets without help content), and also what any hub
   * predating the portal field looks like. Callers must degrade to the ticket
   * flow rather than treating it as an error; `project_id` / `mount_path` are
   * null in that case and nothing was cloned.
   */
  has_portal: boolean;
  /** Local Project id bound to the portal checkout. Null when `!has_portal`. */
  project_id: string | null;
  /** Hub project that owns the ticket queue for this desk. Always present.
   *  Informational — the load flow keys off `project_id`. */
  helpdesk_project_id: string;
  mount_path: string | null;
  /** True when this call performed the clone (false = already present, or no portal). */
  cloned: boolean;
  /**
   * True when this desk came from the project's OWN context folders rather
   * than from the hub. Such a checkout is a context folder the project already
   * resolved and indexed, so the caller must skip fetch/index — those steps
   * operate on the app-managed portal slot, which this is not.
   */
  adopted?: boolean;
}

/**
 * Step A — the checkout exists, cloning it first if it doesn't. Idempotent.
 *
 * `projectId` is the project the user is working in. A project that has
 * adopted a desk of its own (a vendor's help desk attached as a context
 * folder) reaches THAT desk; only a project with none falls through to the
 * instance-wide desk the hub advertises. Omitting it always resolves to the
 * hub's — correct for surfaces with no project in scope.
 */
export async function helpdeskEnsure(projectId?: string | null): Promise<HelpdeskEnsureResult> {
  const action = new ActionInfo('helpdesk-ensure', null, null, 'POST');
  action.bodyParameters = projectId ? { project_id: projectId } : {};
  const res = await dataManager.callAction<Record<string, string>, HelpdeskEnsureResult>(action);
  return res!;
}

export interface HelpdeskRefreshResult {
  /** False when the pull found nothing new ("Already up to date."). */
  updated: boolean;
  message: string;
}

/** Step B — pull the portal repo so local help content matches the remote. */
export async function helpdeskRefresh(): Promise<HelpdeskRefreshResult> {
  const action = new ActionInfo('helpdesk-refresh', null, null, 'POST');
  action.bodyParameters = {};
  const res = await dataManager.callAction<Record<string, never>, HelpdeskRefreshResult>(action);
  return res!;
}

export interface HelpdeskResetResult {
  deleted: boolean;
  /** The folder that was removed, for the confirmation message. */
  mount_path?: string | null;
}

/**
 * Dev-only — delete the local portal Project, its child entities, AND its
 * folder, so the next open re-clones from scratch. Not a hub operation: the
 * desk and its tickets are untouched.
 */
export async function helpdeskReset(): Promise<HelpdeskResetResult> {
  const action = new ActionInfo('helpdesk-reset', null, null, 'POST');
  action.bodyParameters = {};
  const res = await dataManager.callAction<Record<string, never>, HelpdeskResetResult>(action);
  return res!;
}
