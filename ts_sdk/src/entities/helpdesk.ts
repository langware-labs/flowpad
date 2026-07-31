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
  /** Hub project that owns the ticket queue for this desk. Always present. */
  helpdesk_project_id: string;
  mount_path: string | null;
  /** True when this call performed the clone (false = already present, or no portal). */
  cloned: boolean;
}

/** Step A — the checkout exists, cloning it first if it doesn't. Idempotent. */
export async function helpdeskEnsure(): Promise<HelpdeskEnsureResult> {
  const action = new ActionInfo('helpdesk-ensure', null, null, 'POST');
  action.bodyParameters = {};
  const res = await dataManager.callAction<Record<string, never>, HelpdeskEnsureResult>(action);
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

export interface HelpdeskStatusResult {
  /** Null when the hub advertises no desk (or is unreachable). */
  helpdesk_project_id: string | null;
  portal_git_url: string | null;
  /** Local portal Project id, when the checkout has been materialized. */
  project_id: string | null;
  mount_path: string | null;
  exists: boolean;
}

/** Where things stand without changing anything — drives the banner + dev UI. */
export async function helpdeskStatus(): Promise<HelpdeskStatusResult> {
  const action = new ActionInfo('helpdesk-status', null, null, 'POST');
  action.bodyParameters = {};
  const res = await dataManager.callAction<Record<string, never>, HelpdeskStatusResult>(action);
  return res!;
}
