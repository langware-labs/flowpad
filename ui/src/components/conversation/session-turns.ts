import { AttachmentType, type FlowMessage } from '@sdk';

/** The key a session lifecycle line's carrier marker names its event under
 *  (mirror of ``LIVE_SESSION_EVENT_MARKER_KEY`` in flow_message.py). */
const EVENT_MARKER_KEY = 'live_session_event';

/** The prompt a message carries to the host, or its body when it carries none. */
export function promptTextOf(fm: FlowMessage): string {
  for (const a of fm.attachment ?? []) {
    if (a?.attachment_type === AttachmentType.TYPE_ID && (a.data ?? '').startsWith('prompt-') && a.prompt_preview) {
      return a.prompt_preview;
    }
    if (a?.attachment_type === AttachmentType.PROMPT && a.data && !a.data.startsWith('prompt/')) {
      return a.data;
    }
  }
  return fm.text ?? '';
}

/** True when the message carries a prompt for the host to run. */
function carriesPrompt(fm: FlowMessage): boolean {
  return (fm.attachment ?? []).some(
    (a) =>
      (a?.attachment_type === AttachmentType.TYPE_ID && (a.data ?? '').startsWith('prompt-')) ||
      a?.attachment_type === AttachmentType.PROMPT,
  );
}

/** A session reply's text, or null when the message is not a reply. */
export function resultTextOf(fm: FlowMessage): string | null {
  for (const a of fm.attachment ?? []) {
    if (a?.attachment_type === AttachmentType.TYPE_ID && (a.data ?? '').startsWith('prompt_completion-')) {
      return a.prompt_preview ?? fm.text ?? '';
    }
  }
  return null;
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
 * LAST prompt, when a `failed` line follows it and no reply does. A retry is a
 * newer prompt, so once one is sent this answers null. `messages` in time order.
 */
export function failedPromptOf(messages: FlowMessage[]): { message: FlowMessage; text: string } | null {
  let last: FlowMessage | null = null;
  let failed = false;
  for (const fm of messages) {
    if (resultTextOf(fm) !== null) {
      failed = false;
      continue;
    }
    if (sessionEventOf(fm) === 'failed') {
      failed = last !== null;
      continue;
    }
    if (carriesPrompt(fm)) {
      last = fm;
      failed = false;
    }
  }
  if (!failed || !last) return null;
  const text = promptTextOf(last).trim();
  return text ? { message: last, text } : null;
}
