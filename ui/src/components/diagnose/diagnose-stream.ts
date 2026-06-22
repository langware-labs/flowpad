import { ActionInfo, dataManager } from '@sdk';

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
): Promise<void> {
  // Null-entity graph service action → POST /api/v1/graph/diagnose, streamed.
  const info = new ActionInfo('diagnose', null, null, 'POST', false, true, signal);
  info.bodyParameters = { message };
  const resp = await dataManager.callAction<{ message: string }, Response>(info);
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
