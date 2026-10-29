import { dataContext, recentFailedCalls } from '@sdk';
import type { ErrorDetail, NotificationData } from './types';

const MAX_BODY_CHARS = 4096;

interface AxiosLikeError {
  isAxiosError?: boolean;
  config?: { method?: string; url?: string; baseURL?: string; headers?: Record<string, unknown> };
  response?: { status?: number; data?: unknown; headers?: Record<string, unknown> };
  message?: string;
}

function bodyText(data: unknown): string {
  if (data === undefined || data === null) return '';
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  return text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}…` : text;
}

/** The FAIL envelope's message / error code, when the body is one. */
function envelope(data: unknown): { message?: string; errorCode?: string } {
  if (!data || typeof data !== 'object') return {};
  const d = data as { message?: unknown; data?: { error_code?: unknown } };
  return {
    message: typeof d.message === 'string' ? d.message : undefined,
    errorCode: typeof d.data?.error_code === 'string' ? d.data.error_code : undefined,
  };
}

/** An `ErrorDetail` for a thrown value: a failed backend call in full, anything else as its stack. */
export function errorDetailFrom(error: unknown): ErrorDetail | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const e = error as AxiosLikeError & Error;
  if (e.isAxiosError || e.config) {
    const headers = e.response?.headers ?? {};
    const requestId = headers['x-flow-request-id'] ?? headers['x-request-id'];
    return {
      source: 'api',
      request: {
        method: e.config?.method?.toUpperCase(),
        url: e.config?.url,
        caller:
          typeof e.config?.headers?.['X-Flow-Caller'] === 'string' ? e.config.headers['X-Flow-Caller'] : undefined,
      },
      response: {
        status: e.response?.status,
        ...envelope(e.response?.data),
        body: bodyText(e.response?.data) || e.message,
        requestId: typeof requestId === 'string' ? requestId : undefined,
      },
    };
  }
  if (e instanceof Error) return { source: 'app', response: { message: e.message, body: e.stack } };
  return undefined;
}

/** What this app is, for the "This app" section — read when the popup opens. */
export function appContext(): { version?: string; instance?: string } {
  const info = dataContext.bootstrapInfo;
  return { version: info?.version, instance: info?.instance_name };
}

const fmtTime = (ms?: number) => (ms ? new Date(ms).toLocaleString() : undefined);

/** One section of the popup: a heading and its present rows. Shared by the popup and the copy text. */
export interface DetailSection {
  title: string;
  rows: [label: string, value: string][];
}

/** The popup's sections for a notification — only the rows that have a value. */
export function detailSections(data: NotificationData, labels: Record<string, string>): DetailSection[] {
  const d = data.detail;
  const app = appContext();
  const count = d?.count ?? data.count;
  const sections: DetailSection[] = [
    {
      title: labels.request,
      rows: [
        [labels.call, [d?.request?.method, d?.request?.url].filter(Boolean).join(' ')],
        [labels.madeBy, d?.request?.caller ?? ''],
      ],
    },
    {
      title: labels.answer,
      rows: [
        [labels.status, d?.response?.status ? String(d.response.status) : ''],
        [labels.message, d?.response?.message ?? data.message ?? ''],
        [labels.errorCode, d?.response?.errorCode ?? ''],
        [labels.said, d?.response?.body ?? ''],
        [labels.requestId, d?.response?.requestId ?? ''],
      ],
    },
    {
      title: labels.limit,
      rows: [
        [labels.rule, d?.limit?.rule ?? ''],
        [labels.usedCap, [d?.limit?.used, d?.limit?.cap].filter(Boolean).join(' / ')],
        [labels.endpoint, d?.limit?.endpoint ?? ''],
      ],
    },
    {
      title: labels.when,
      rows: [
        [labels.first, fmtTime(d?.firstAt ?? data.firstAt) ?? ''],
        [labels.last, fmtTime(d?.lastAt ?? data.timestamp) ?? ''],
        [labels.times, count && count > 1 ? String(count) : ''],
      ],
    },
    {
      title: labels.app,
      rows: [
        [labels.version, [app.version, app.instance && `instance ${app.instance}`].filter(Boolean).join(' · ')],
        [labels.log, d?.logFile ?? ''],
      ],
    },
  ];
  return sections.map((s) => ({ ...s, rows: s.rows.filter(([, v]) => v) })).filter((s) => s.rows.length > 0);
}

/** The whole popup as text — what Copy all copies and what Diagnose is seeded with. */
export function detailText(data: NotificationData, sections: DetailSection[]): string {
  const lines = [data.title, data.message ?? ''];
  for (const s of sections) {
    lines.push('', `## ${s.title}`, ...s.rows.map(([k, v]) => `${k}: ${v}`));
  }
  for (const h of data.detail?.hidden ?? []) {
    const r = h.detail.request;
    lines.push('', `## ${h.title}`, `${r?.method ?? ''} ${r?.url ?? ''} → ${h.detail.response?.status ?? ''}`);
    if (h.detail.response?.message) lines.push(h.detail.response.message);
  }
  return lines
    .filter((l, i) => l || i > 1)
    .join('\n')
    .trim();
}

const MATCH_WINDOW_MS = 10_000;

/**
 * The failed backend call an alert is about, when the caller showed only its text: a call from the
 * last few seconds whose own message (axios's "Request failed with status code 409") or backend
 * answer appears in the alert. No match → no detail; never a guess at an unrelated call.
 */
export function detailFromRecentCall(title: string, message?: string): ErrorDetail | undefined {
  const text = `${title}\n${message ?? ''}`;
  const now = Date.now();
  for (const call of recentFailedCalls) {
    if (now - call.at > MATCH_WINDOW_MS) break;
    const detail = errorDetailFrom(call.error);
    const answer = detail?.response?.message;
    if ((call.message && text.includes(call.message)) || (answer && text.includes(answer))) return detail;
  }
  return undefined;
}
