import type { SendReplyExtras } from '@sdk/entities/notifications';

/** The participant whose machine a prompt runs on. */
export interface SessionHost {
  userId: string;
  name: string | null;
}

/**
 * Wire extras for a prompt send. The text rides as the PROMPT attachment (the
 * body stays empty; the backend synthesizes its placeholder). A follow-up
 * inside a session carries `sessionId`; a NEW session carries the opening
 * proposal (`replyPolicy`) and NO session id — the backend mints the id and
 * creates the sender's session row. Pure, so the contract is unit-testable.
 */
export function buildSessionStartExtras({
  text,
  files,
  sessionId,
  replyPolicy,
}: {
  text: string;
  files: File[];
  sessionId: string | null;
  replyPolicy: 'auto' | 'review' | null;
}): SendReplyExtras {
  const extras: SendReplyExtras = { promptText: text };
  if (files.length > 0) extras.promptFiles = files;
  if (sessionId) extras.remoteWorkerSessionId = sessionId;
  else if (replyPolicy) extras.replyPolicy = replyPolicy;
  return extras;
}
