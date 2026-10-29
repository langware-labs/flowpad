import { ActionInfo, dataContext, dataManager, requestWithFiles, type DiagnosisSpec, type HelpRecipient } from '@sdk';

/** Who the diagnosis goes to, and when (``flow_sdk.diagnose.share.DiagnoseShare``). */
export interface DiagnoseShare {
  share_with: HelpRecipient[];
  /** Send when the run finishes, from the backend — the window may be long closed. */
  send_when_done: boolean;
  /** Minted by the window: the same id is the same send. */
  conversation_id: string;
}

/** One conversation the diagnosis was sent into. */
export interface DiagnoseShared {
  conversation_id: string;
  to: string;
}

/**
 * The SSE events forwarded verbatim by POST /api/v1/graph/diagnose — mirrors the
 * event dicts emitted by `_run_diagnose` (flow_sdk/cli/commands/diagnose_cmd.py).
 */
export type DiagnoseEvent =
  | { type: 'status'; text: string }
  | { type: 'narration'; text: string }
  | { type: 'error'; text: string }
  | { type: 'progress' }
  | { type: 'flush' }
  | {
      type: 'done';
      ok: boolean;
      diagnosis_id: string | null;
      conversation_id: string | null;
      flow_message_id: string | null;
      feed_posted?: boolean;
      /** The diagnosis value — the merged one when recorded, the sweep's when the agent failed. */
      diagnosis?: DiagnosisSpec | null;
      /** Where it was sent ("Send report once done"). */
      shared?: DiagnoseShared[];
      /** People were picked but nothing was sent yet — it waits for "Send to …". */
      share_pending?: boolean;
    };

/**
 * Run the Flowpad self-diagnosis and deliver each streamed SSE event to
 * `onEvent`. Resolves when the stream ends; throws on transport failure (the
 * caller distinguishes `signal.aborted`). The single consumer of the diagnose
 * streaming protocol — both the version-popover modal and the notification
 * "diagnose this error" modal go through here.
 */
export async function streamDiagnose(
  message: string,
  onEvent: (ev: DiagnoseEvent) => void,
  signal?: AbortSignal,
  files: File[] = [],
  share?: DiagnoseShare | null,
): Promise<void> {
  // Null-entity graph service action → POST /api/v1/graph/diagnose, streamed.
  // The active project rides along so the recorded diagnosis remembers the
  // project the issue happened on (its origin project).
  const info = new ActionInfo('diagnose', null, null, 'POST', false, true, signal);
  // Files (screenshots of the issue) ride along multipart, the way ask-for-help sends them.
  // ``share_with`` rides as JSON text: a multipart body carries strings.
  info.bodyParameters = requestWithFiles(
    {
      message,
      project_id: dataContext.project?.id ?? null,
      ...(share?.share_with.length
        ? {
            share_with: JSON.stringify(share.share_with),
            send_when_done: share.send_when_done ? 'true' : 'false',
            conversation_id: share.conversation_id,
          }
        : {}),
    },
    files,
  );
  const resp = await dataManager.callAction<unknown, Response>(info);
  if (!resp || !resp.body) throw new Error('No streaming response body');

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  // Parse the SSE stream: events are separated by a blank line; each carries a
  // single `data: <json>` field.
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      for (const raw of frame.split('\n')) {
        const trimmed = raw.startsWith('data:') ? raw.slice(5).trim() : '';
        if (!trimmed) continue;
        try {
          onEvent(JSON.parse(trimmed) as DiagnoseEvent);
        } catch {
          /* ignore malformed frame */
        }
      }
    }
  }
}

/**
 * Send a recorded diagnosis now — the not-sent toast's "Send to …". The same send the run
 * makes on its own when "Send report once done" is on (POST /api/v1/graph/diagnose-send).
 */
export async function sendDiagnosis(
  diagnosisId: string,
  shareWith: HelpRecipient[],
  conversationId?: string,
): Promise<DiagnoseShared[]> {
  const info = new ActionInfo('diagnose-send', null, null, 'POST');
  info.bodyParameters = {
    diagnosis_id: diagnosisId,
    share_with: shareWith,
    project_id: dataContext.project?.id ?? null,
    ...(conversationId ? { conversation_id: conversationId } : {}),
  };
  const res = await dataManager.callAction<unknown, { shared: DiagnoseShared[] }>(info);
  return res?.shared ?? [];
}
