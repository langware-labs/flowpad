/**
 * The calls a diagnosis request's screens make. Every decision is the backend's: opening a
 * request, uploading a local key or an attachment, allocating the budget and talking to the hub
 * all happen behind the type's actions (`flow_sdk/app/actions/diagnosis_request_action.py`).
 */
import { ActionInfo, DiagnosisRequest, dataManager } from '@sdk';

/** A hub budget the owner may (or may only ask someone to) hand out. */
export interface HubFundingSource {
  typeid: string;
  name: string;
  provider: string;
  can_allocate: boolean;
  manager?: string | null;
}

/** `funding_sources`: the hub's budgets, and the LLM keys stored on this computer. */
export interface FundingSources {
  hub: HubFundingSource[];
  local_keys: { provider: string }[];
}

/** One thing the runner will receive. */
export interface RequestAttachment {
  kind: 'files' | 'skills';
  name: string;
  size?: number | null;
}

/** One kept run, as `runs` lists it. */
export interface RunSummary {
  run: number;
  title?: string | null;
  at?: string | null;
  files: string[];
}

/** One run, whole (`runs/<n>`): the diagnosis it recorded and its files. */
export interface RunDetail {
  run: number;
  title?: string | null;
  at?: string | null;
  reported_by?: string | null;
  os?: string | null;
  app_version?: string | null;
  summary?: string | null;
  user_report?: string | null;
  symptoms?: string | null;
  rca?: string | null;
  fix?: string | null;
  files?: Record<string, string>;
}

/** A file or an asset sent along: `DiagnosisAttachmentSpec`. */
export type AttachmentBody = { file_name: string; content_b64: string } | { asset_typeid: string };

/** `DiagnosisRequestOpenSpec`. */
export interface OpenRequestBody {
  instructions: string;
  ask_permission: boolean;
  project_id: string;
  write_hours: number;
  max_run_mb: number;
  attachments: AttachmentBody[];
  funding?: {
    cost_usd_total: number;
    hours: number;
    model: string;
    source_typeid?: string;
    local_key_provider?: string;
  };
}

/** `DiagnosisRequestEditSpec`: only what changes is sent. */
export interface EditRequestBody {
  instructions?: string;
  ask_permission?: boolean;
  write_hours?: number;
  max_run_mb?: number;
  funding?: OpenRequestBody['funding'];
}

/** An action on the type (`id` null) or on one request. */
export function requestAction(
  name: string,
  {
    id = null,
    method = 'GET',
    body,
    subpath,
  }: { id?: string | null; method?: 'GET' | 'POST'; body?: object; subpath?: string } = {},
): ActionInfo {
  const info = new ActionInfo(name, DiagnosisRequest.type, id, method);
  if (body) info.bodyParameters = body as Record<string, unknown>;
  if (subpath) info.subpath = subpath;
  return info;
}

export function callRequestAction<T>(...args: Parameters<typeof requestAction>): Promise<T> {
  return dataManager.callAction<unknown, T>(requestAction(...args));
}

export function openRequest(body: OpenRequestBody): Promise<{ request: DiagnosisRequest; command: string }> {
  return callRequestAction('open_request', { method: 'POST', body });
}

export function editRequest(id: string, body: EditRequestBody): Promise<DiagnosisRequest> {
  return callRequestAction('edit', { id, method: 'POST', body });
}

/** What the owner sends the person they support. */
export function commandFor(id: string): string {
  return `flow diagnose ${id}`;
}

/** A picked file as the action takes it: its name and its bytes, base64. */
export function readFile(file: File): Promise<{ file_name: string; content_b64: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve({ file_name: file.name, content_b64: (reader.result as string).split(',', 2)[1] || '' });
    reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

export function errorText(error: unknown): string {
  const e = error as { response?: { data?: { message?: string } }; message?: string } | null;
  return e?.response?.data?.message || e?.message || String(error);
}

export function formatSize(bytes: number | null | undefined): string {
  if (bytes == null) return '';
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/**
 * The first turn of an "explain the result" session: what the owner asked, the request, and every
 * run's texts inline; each run's files ride as uploads (`run-<n>-<name>`), referenced by path, so a
 * long log never bloats the prompt. Agent-facing text, so it is not translated.
 */
export function explainPrompt(
  request: DiagnosisRequest,
  attachments: RequestAttachment[],
  runs: RunDetail[],
): { message: string; files: File[] } {
  const lines = [
    'This is the result of a diagnosis I asked someone I support to run on their computer',
    `(\`flow diagnose ${request.id}\`). Summarize it and explain it to me in plain language:`,
    'what they ran into, the root cause, and the fix -- and what, if anything, I should do next.',
    '',
    '## What I asked them',
    request.instructions?.trim() || '(no instructions -- a standard diagnosis)',
  ];
  if (attachments.length) {
    lines.push('', 'Sent along:', ...attachments.map((a) => `- ${a.kind === 'skills' ? 'skill' : 'file'}: ${a.name}`));
  }
  lines.push(
    '',
    '## The request',
    `- id: ${request.id}`,
    `- accepted runs until: ${request.write_expires_at ?? 'unknown'}`,
    `- LLM budget: ${request.llm_endpoint_typeid || 'none -- they used their own'}`,
    `- runs: ${runs.length}`,
  );
  const files: File[] = [];
  for (const run of runs) {
    lines.push('', `## Run ${run.run}${run.at ? ` (${run.at})` : ''}`);
    const fields: [string, string | null | undefined][] = [
      ['Reported by', run.reported_by],
      ['OS', run.os],
      ['App version', run.app_version],
      ['Title', run.title],
      ['Their description', run.user_report],
      ['Symptoms', run.symptoms],
      ['Root cause', run.rca],
      ['Fix', run.fix],
      ['Summary', run.summary],
    ];
    for (const [label, value] of fields) if (value?.trim()) lines.push(`### ${label}`, value.trim());
    for (const [name, text] of Object.entries(run.files ?? {})) {
      files.push(new File([text], `run-${run.run}-${name.replace(/[\\/]/g, '_')}`, { type: 'text/plain' }));
    }
  }
  if (files.length) lines.push('', "The runs' files are attached below -- read them.");
  return { message: lines.join('\n'), files };
}
