import { AttachmentType, type FlowMessage } from '@sdk';
import { attachmentDataString } from '@sdk/entities/flow-message';
import { REPLY_MARKER_TYPE } from './attachment-plumbing';
import {
  PROMPT_FILE_PREFIX,
  isPromptMessage,
  promptAttachmentsOf,
  promptEntityIdOf,
} from './attachment-actions/prompt-attachment';

/** The key a session lifecycle line's carrier marker names its event under
 *  (mirror of ``LIVE_SESSION_EVENT_MARKER_KEY`` in flow_message.py). */
const EVENT_MARKER_KEY = 'live_session_event';

/** The prompt a message carries to the host, or its body when it carries none. */
export function promptTextOf(fm: FlowMessage): string {
  for (const a of promptAttachmentsOf(fm)) {
    if (promptEntityIdOf(a) && a.prompt_preview) return a.prompt_preview;
    const data = attachmentDataString(a);
    if (a.attachment_type === AttachmentType.PROMPT && data && !data.startsWith(PROMPT_FILE_PREFIX)) return data;
  }
  return fm.text ?? '';
}

/** A session reply's text, or null when the message is not a reply. */
export function resultTextOf(fm: FlowMessage): string | null {
  const reply = (fm.attachment ?? []).find(
    (a) => a?.attachment_type === AttachmentType.TYPE_ID && attachmentDataString(a).startsWith(`${REPLY_MARKER_TYPE}-`),
  );
  return reply ? (reply.prompt_preview ?? fm.text ?? '') : null;
}

/** A session lifecycle line's event ("approved", "failed", …), or null. */
export function sessionEventOf(fm: FlowMessage): string | null {
  for (const a of fm.attachment ?? []) {
    if (a?.attachment_type !== AttachmentType.TYPE_ID || !(a.data ?? '').startsWith('remote_worker_session-')) continue;
    try {
      const marker = JSON.parse(a.prompt_preview ?? '') as Record<string, unknown>;
      const event = marker?.[EVENT_MARKER_KEY];
      if (typeof event === 'string') return event;
    } catch {
      // not a marker
    }
  }
  return null;
}

/**
 * The prompt the host failed to run and nobody has answered since: the session's
 * LAST prompt, when a `failed` line follows it and no reply does — with that line,
 * which is where the session view offers Retry. A retry is a newer prompt, so
 * once one is sent this answers null. `messages` in time order.
 */
export function failedPromptOf(
  messages: FlowMessage[],
): { message: FlowMessage; text: string; line: FlowMessage } | null {
  let last: FlowMessage | null = null;
  let line: FlowMessage | null = null; // the `failed` line that follows `last`, if any
  for (const fm of messages) {
    if (resultTextOf(fm) !== null) {
      line = null;
      continue;
    }
    if (sessionEventOf(fm) === 'failed') {
      if (last) line = fm;
      continue;
    }
    if (isPromptMessage(fm)) {
      last = fm;
      line = null;
    }
  }
  if (!line || !last) return null;
  const text = promptTextOf(last).trim();
  return text ? { message: last, text, line } : null;
}
