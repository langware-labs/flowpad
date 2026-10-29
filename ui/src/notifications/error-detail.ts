import { t } from '@lingui/core/macro';
import { dataContext, describeFailedCall, recentFailedCalls } from '@sdk';
import type { ErrorDetail, NotificationData } from './types';

/** An `ErrorDetail` for a thrown value: a failed backend call in full, anything else as its stack. */
export function errorDetailFrom(error: unknown): ErrorDetail | undefined {
  const call = describeFailedCall(error);
  if (call) return call;
  if (error instanceof Error) return { response: { message: error.message, body: error.stack } };
  return undefined;
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
    const answer = call.detail.response.message;
    if ((call.message && text.includes(call.message)) || (answer && text.includes(answer))) return call.detail;
  }
  return undefined;
}

// The hub's limit refusal ("limit 'cost_usd_total' exceeded on endpoint <name> (<id>)", hub
// `core/llm/limits.py`) — read back into fields wherever the sentence shows up.
const LIMIT_SENTENCE = /limit '([\w.]+)'.*?on endpoint (.+?) \(([0-9a-f-]+)\)/;

export function limitFromText(text: string): ErrorDetail['limit'] | undefined {
  const m = LIMIT_SENTENCE.exec(text);
  return m ? { rule: m[1], endpoint: `${m[2]} · ${m[3]}` } : undefined;
}

const fmtTime = (ms?: number) => (ms ? new Date(ms).toLocaleString() : '');

/** One section of the popup: a heading and its present rows. Shared by the popup and the copy text. */
export interface DetailSection {
  title: string;
  rows: [label: string, value: string][];
}

/** One hidden error as a line: what was called and what came back. */
export function hiddenLine(h: { detail: ErrorDetail }): string {
  const { request, response } = h.detail;
  return [request?.method, request?.url, '→', response?.status, response?.message].filter(Boolean).join(' ');
}

/** The popup's sections for a notification — only the rows that have a value. */
export function detailSections(data: NotificationData): DetailSection[] {
  const d = data.detail ?? {};
  const limit = d.limit ?? limitFromText(`${data.message ?? ''}\n${d.response?.message ?? ''}`);
  const info = dataContext.bootstrapInfo;
  const count = d.count ?? data.count;
  const sections: DetailSection[] = [
    {
      title: t`Request`,
      rows: [
        [t`Call`, [d.request?.method, d.request?.url].filter(Boolean).join(' ')],
        [t`Made by`, d.request?.caller ?? ''],
      ],
    },
    {
      title: t`Answer`,
      rows: [
        [t`Status`, d.response?.status ? String(d.response.status) : ''],
        [t`Message`, d.response?.message ?? data.message ?? ''],
        [t`Error code`, d.response?.errorCode ?? ''],
        [t`Full answer`, d.response?.body ?? ''],
        [t`Request id`, d.response?.requestId ?? ''],
      ],
    },
    {
      title: t`Limit`,
      rows: [
        [t`Rule`, limit?.rule ?? ''],
        [t`Used / cap`, [limit?.used, limit?.cap].filter(Boolean).join(' / ')],
        [t`Endpoint`, limit?.endpoint ?? ''],
      ],
    },
    {
      title: t`When`,
      rows: [
        [t`First`, fmtTime(d.firstAt ?? data.firstAt)],
        [t`Last`, fmtTime(d.lastAt ?? data.timestamp)],
        [t`Times`, count && count > 1 ? String(count) : ''],
      ],
    },
    {
      title: t`This app`,
      rows: [
        [
          t`Version`,
          [info?.version, info?.instance_name && `instance ${info.instance_name}`].filter(Boolean).join(' · '),
        ],
        [t`Log`, d.logFile ?? ''],
      ],
    },
  ];
  return sections.map((s) => ({ ...s, rows: s.rows.filter(([, v]) => v) })).filter((s) => s.rows.length > 0);
}

/** The whole popup as text — what Copy all copies and what Diagnose is seeded with. */
export function detailText(data: NotificationData, sections: DetailSection[]): string {
  const lines = [data.title, ...(data.message ? [data.message] : [])];
  for (const s of sections) lines.push('', `## ${s.title}`, ...s.rows.map(([k, v]) => `${k}: ${v}`));
  const hidden = data.detail?.hidden ?? [];
  if (hidden.length) lines.push('', `## ${t`Hidden errors`}`, ...hidden.map(hiddenLine));
  return lines.join('\n');
}
