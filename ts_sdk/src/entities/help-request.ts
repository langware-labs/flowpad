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
export type HelpOrigin = 'vibe' | 'footer' | 'top_bar' | 'portal' | 'portal_agent_chat' | 'load_failure' | 'assistant' | 'credential' | 'warning';

export type HelpRecipient = {
  kind: HelpRecipientKind;
  email?: string | null;
  user_id?: string | null;
  /** The desk's hub queue id; null asks the nearest desk (resolved when delivered). */
  desk_project_id?: string | null;
  name?: string | null;
};

/** What Ask does once the request is written: send it, or keep it here until the person shares it. */
export type HelpSend = 'when_diagnosed' | 'review_first';

export type AskForHelpRequest = {
  /** Minted by the asker and kept across resubmits: the same id is the same request. */
  conversation_id?: string | null;
  /** At most one desk and any number of people. None: a private conversation that stays here. */
  recipients?: HelpRecipient[];
  /** One recipient, as older callers send it. */
  recipient?: HelpRecipient | null;
  title?: string;
  text: string;
  project_id?: string | null;
  /** Exactly what the person chose to attach (TypeIds). */
  context?: string[];
  origin?: HelpOrigin;
  /** "Run diagnosis": diagnose this machine before the request is sent. */
  diagnose?: boolean;
  /** "Share context": the diagnosis, screen, session and logs go with the request. */
  share_context?: boolean;
  /** Context files the person left out in the review. */
  left_out?: string[];
  send?: HelpSend;
  /** A diagnosis already taken: it is the one attached, nothing is diagnosed again. */
  diagnosis_id?: string | null;
  /** The session on screen (a TypeId) — what the diagnose is told the person was in. */
  process?: string | null;
  /** The window asked from (its socket's id): what the context says was on screen. */
  connection_id?: string | null;
  /** `repair` fixes what it safely can (Diagnose & fix); `report` only describes (the default). */
  purpose?: 'report' | 'repair';
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
  /** It went to the hub (false: kept here — review first, or nobody to ask). */
  shared: boolean;
  /** Its context went with it. */
  context_shared: boolean;
  /** A diagnosis runs in the background and lands as its own message. */
  diagnosing?: boolean;
}

/** A context file: its name and text, as the review shows it. */
export interface HelpContextItem {
  name: string;
  content: string;
}

/** What Ask would attach, and the title card 3 shows — nothing is written. */
export async function helpRequestPreview(
  request: AskForHelpRequest,
): Promise<{ title: string; items: HelpContextItem[] }> {
  const action = new ActionInfo('help-request-preview', null, null, 'POST');
  action.bodyParameters = request;
  const res = await dataManager.callAction<unknown, { title: string; items: HelpContextItem[] }>(action);
  return res ?? { title: '', items: [] };
}

/** The context captured for a request and not shared yet. */
export async function helpRequestContext(conversationId: string): Promise<HelpContextItem[]> {
  return (await helpRequestHeld(conversationId)).items;
}

/** The held context, and whether the request is still private (nobody to share it with yet). */
export async function helpRequestHeld(conversationId: string): Promise<{ items: HelpContextItem[]; private: boolean }> {
  const action = new ActionInfo('help-request-context', 'conversation', conversationId, 'POST');
  action.bodyParameters = {};
  const res = await dataManager.callAction<unknown, { items: HelpContextItem[]; private?: boolean }>(action);
  return { items: res?.items ?? [], private: !!res?.private };
}

/** The person's Share: the request goes to the hub, its held context follows (minus what they left out). */
export async function helpRequestShare(conversationId: string, leftOut: string[] = []): Promise<string[]> {
  const action = new ActionInfo('help-request-share', 'conversation', conversationId, 'POST');
  action.bodyParameters = { left_out: leftOut };
  const res = await dataManager.callAction<unknown, { shared: string[] }>(action);
  return res?.shared ?? [];
}

/** Report it: a private request becomes a ticket in the desk its diagnosis points at, with everything held here. */
export async function helpRequestReport(
  conversationId: string,
): Promise<{ conversation_id: string; desk: string; pass_on: string }> {
  const action = new ActionInfo('help-request-report', 'conversation', conversationId, 'POST');
  action.bodyParameters = {};
  const res = await dataManager.callAction<unknown, { conversation_id: string; desk: string; pass_on: string }>(action);
  return res!;
}

/** What a request's diagnosis message offers: its verdict, and whether (and to whom) a report is offered. */
export interface HelpRequestDiagnosis {
  diagnosing: boolean;
  diagnosis: import('../diagnose/types').DiagnosisSpec | null;
  reportable: boolean;
  reported: boolean;
  /** Who Report it goes to ("Flowpad support", "acme-planner's help desk"). */
  desk: string;
  /** A dependency with no desk: Flowpad support passes it on to this. */
  pass_on: string;
}

export async function helpRequestDiagnosis(conversationId: string): Promise<HelpRequestDiagnosis> {
  const action = new ActionInfo('help-request-diagnosis', 'conversation', conversationId, 'POST');
  action.bodyParameters = {};
  const res = await dataManager.callAction<unknown, HelpRequestDiagnosis>(action);
  return res ?? { diagnosing: false, diagnosis: null, reportable: false, reported: false, desk: '', pass_on: '' };
}

/** An action body: the request itself, or — with files — a multipart form carrying it in ``request``. */
export function requestWithFiles<T extends object>(request: T, files: File[]): T | FormData {
  if (!files.length) return request;
  const form = new FormData();
  form.append('request', JSON.stringify(request));
  for (const file of files) form.append('files', file, file.name);
  return form;
}

/** Write a help request here, then let delivery take it to the hub. Files ride along multipart. */
export async function askForHelp(request: AskForHelpRequest, files: File[] = []): Promise<AskForHelpResult> {
  const action = new ActionInfo('ask-for-help', null, null, 'POST');
  action.bodyParameters = requestWithFiles(request, files);
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
  unread: number;
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
