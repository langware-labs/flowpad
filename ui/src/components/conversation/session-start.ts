import type { SendReplyExtras } from '@sdk/entities/notifications';

/** The participant whose machine a prompt runs on. */
export interface SessionHost {
  name: string | null;
  /** The conversation already has an open live session: a prompt sent now
   *  joins it (the backend's one-open-session rule) instead of opening one. */
  hasOpenSession?: boolean;
}

/**
 * Wire extras for a prompt sent into a live session. The text rides as the
 * PROMPT attachment (the body stays empty; the backend synthesizes its
 * placeholder) and the turn is stamped with the session id. Pure, so the
 * contract is unit-testable.
 */
export function buildSessionStartExtras({
  text,
  files,
  sessionId,
}: {
  text: string;
  files: File[];
  sessionId: string | null;
}): SendReplyExtras {
  const extras: SendReplyExtras = { promptText: text };
  if (files.length > 0) extras.promptFiles = files;
  if (sessionId) extras.remoteWorkerSessionId = sessionId;
  return extras;
}
