import { AttachmentType, type FlowMessage } from '@sdk';
import { attachmentDataString } from '@sdk/entities/flow-message';
import { truncate } from '@src/components/hooks/event-summaries';
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

/** The session's last prompt, the `failed` line that follows it (if any), and
 *  whether anything — a reply or a failure — answered it. `messages` in time order. */
function lastTurnOf(messages: FlowMessage[]): {
  prompt: FlowMessage | null;
  failedLine: FlowMessage | null;
  answered: boolean;
} {
  let prompt: FlowMessage | null = null;
  let failedLine: FlowMessage | null = null;
  let answered = false;
  for (const fm of messages) {
    if (resultTextOf(fm) !== null) {
      failedLine = null;
      answered = true;
    } else if (sessionEventOf(fm) === 'failed') {
      if (prompt) failedLine = fm;
      answered = true;
    } else if (isPromptMessage(fm)) {
      prompt = fm;
      failedLine = null;
      answered = false;
    }
  }
  return { prompt, failedLine, answered };
}

/**
 * The prompt the host failed to run and nobody has answered since: the session's
 * LAST prompt, when a `failed` line follows it and no reply does — with that line,
 * which is where the session view offers Retry. A retry is a newer prompt, so
 * once one is sent this answers null.
 */
export function failedPromptOf(
  messages: FlowMessage[],
): { message: FlowMessage; text: string; line: FlowMessage } | null {
  const { prompt, failedLine } = lastTurnOf(messages);
  if (!prompt || !failedLine) return null;
  const text = promptTextOf(prompt).trim();
  return text ? { message: prompt, text, line: failedLine } : null;
}

/** The prompt the host is working on: the session's LAST prompt while nothing
 *  answered it — what the session names while it runs. */
export function pendingPromptOf(messages: FlowMessage[]): string | null {
  const { prompt, answered } = lastTurnOf(messages);
  return (prompt && !answered && promptTextOf(prompt).trim()) || null;
}

/** A prompt as one line: its first line, truncated. */
export function sessionTitle(prompt: string, max = 80): string {
  return truncate(prompt.trim().split('\n')[0] ?? '', max - 1);
}
