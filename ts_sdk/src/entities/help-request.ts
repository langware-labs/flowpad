import { dataManager } from '../APIEntity';
import { ActionInfo } from '../models/ActionInfo';

/**
 * Asking for help — the one request both channels send (docs/collab/ask-for-help.md).
 *
 * Mirrors ``flow_sdk/schema/data_spec/help_request_spec.py``. ``askForHelp`` writes the request on
 * this machine first and resolves once it is written; delivery to the hub follows, and its state
 * rides back on the answer (``delivery``) and on the message (``delivery_failure``).
 */

export type HelpRecipientKind = 'person' | 'desk';
export type HelpOrigin = 'vibe' | 'footer' | 'portal' | 'portal_agent_chat' | 'load_failure' | 'assistant';

export type HelpRecipient = {
  kind: HelpRecipientKind;
  email?: string | null;
  user_id?: string | null;
  /** The desk's hub queue id; null asks the nearest desk (resolved when delivered). */
  desk_project_id?: string | null;
  name?: string | null;
};

export type AskForHelpRequest = {
  /** Minted by the asker and kept across resubmits: the same id is the same request. */
  conversation_id?: string | null;
  recipient: HelpRecipient;
  title?: string;
  text: string;
  project_id?: string | null;
  /** Exactly what the person chose to attach (TypeIds). */
  context?: string[];
  origin?: HelpOrigin;
};

/** Why the hub does not have something — mirrors ``HubFailure``. Match ``kind``, never ``message``. */
export type HubFailureKind = 'offline' | 'not_configured' | 'signed_out' | 'rejected' | 'server_error';

export interface HubFailure {
  kind: HubFailureKind;
  status?: number | null;
  code?: string | null;
  message: string;
}

export interface DeliveryState {
  header: string;
  body: string | null;
  failure: HubFailure | null;
}

export interface AskForHelpResult {
  conversation_id: string;
  task_id: string | null;
  message_id: string;
  delivery: DeliveryState;
}

/** Write a help request here, then let delivery take it to the hub. Files ride along multipart. */
export async function askForHelp(request: AskForHelpRequest, files: File[] = []): Promise<AskForHelpResult> {
  const action = new ActionInfo('ask-for-help', null, null, 'POST');
  if (files.length) {
    const form = new FormData();
    form.append('request', JSON.stringify(request));
    for (const file of files) form.append('files', file, file.name);
    action.bodyParameters = form;
  } else {
    action.bodyParameters = request;
  }
  const res = await dataManager.callAction<unknown, AskForHelpResult>(action);
  return res!;
}

export interface HelpRecipients {
  desks: HelpRecipient[];
  /** ``unknown``: offline, no desk remembered yet — asking still works, it is resolved on delivery. */
  default_state: 'known' | 'unknown' | 'not_configured';
}

/** The desks this person can ask, nearest first. */
export async function helpRecipients(projectId?: string | null): Promise<HelpRecipients> {
  const action = new ActionInfo('help-recipients', null, null, 'POST');
  action.bodyParameters = { project_id: projectId ?? '' };
  const res = await dataManager.callAction<unknown, HelpRecipients>(action);
  return res ?? { desks: [], default_state: 'unknown' };
}

export interface HelpRequestRow {
  conversation_id: string;
  task_id: string | null;
  kind: 'person' | 'desk';
  recipient_label: string | null;
  title: string;
  status: 'open' | 'resolved' | 'closed';
  delivery: DeliveryState;
  delivered: boolean;
}

/** My help requests, both kinds — including ones not delivered yet. */
export async function helpRequests(projectId?: string | null): Promise<HelpRequestRow[]> {
  const action = new ActionInfo('help-requests', null, null, 'POST');
  action.bodyParameters = { project_id: projectId ?? '' };
  const res = await dataManager.callAction<unknown, { requests: HelpRequestRow[] }>(action);
  return res?.requests ?? [];
}

/** The person's Retry: deliver what this conversation still owes the hub, refusals included. */
export async function resendConversation(conversationId: string): Promise<void> {
  const action = new ActionInfo('resend', 'conversation', conversationId, 'POST');
  action.bodyParameters = {};
  await dataManager.callAction(action);
}
