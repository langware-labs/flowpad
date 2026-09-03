/**
 * Pull a human-readable message out of whatever a failed call threw.
 *
 * Errors reach the UI in three shapes depending on how far they got: a real
 * `Error` from client-side code, an axios-style rejection carrying the backend
 * envelope at `response.data`, or a bare envelope. The order below is the one
 * that was already copy-pasted across the env-var handlers — backend detail
 * first, because when the server explains itself that is the message worth
 * showing.
 *
 * `ts_sdk/src/client.ts`'s `getErrorMessages` does not fit here: it is typed to
 * an axios error and unwraps a different envelope.
 */

interface ErrorEnvelope {
  response?: { data?: { detail?: string; message?: string } };
  detail?: string;
  message?: string;
}

/**
 * The server's own sentence, or '' — the ENVELOPE only.
 *
 * Differs from {@link errorMessage} in exactly one way, and it matters: no `Error.message`
 * fallback. An AxiosError is both an Error and an envelope carrier, and its message is always
 * "Request failed with status code 4xx" — so a failure the server did not explain would put the
 * status line in front of the user as if it were an explanation. Callers that want to substitute
 * their own wording for an unexplained failure need to be able to tell "no detail" apart from
 * "detail happens to be boilerplate".
 */
export function errorDetail(error: unknown): string {
  const e = typeof error === 'object' && error !== null ? (error as ErrorEnvelope) : null;
  return e?.response?.data?.detail || e?.response?.data?.message || '';
}

export function errorMessage(error: unknown, fallback: string): string {
  const e = typeof error === 'object' && error !== null ? (error as ErrorEnvelope) : null;

  // The envelope is checked BEFORE `Error.message`, and the order matters: an
  // AxiosError is BOTH — an Error whose message is the useless "Request failed
  // with status code 500", carrying the server's actual explanation at
  // `response.data`. Testing `instanceof Error` first threw that away and put
  // the status line in front of the user.
  const fromEnvelope = errorDetail(error);
  if (fromEnvelope) return fromEnvelope;

  if (error instanceof Error && error.message) return error.message;

  return e?.detail || e?.message || fallback;
}

/**
 * The backend's machine error code and its human message, together.
 *
 * A route that fails with the standard envelope puts the code at
 * `data.error_code` (`flow_sdk/server/routes/transcripts.py:_error`), which is
 * what a caller branches on — sniffing the message string for a prefix is too
 * brittle for that. Falls back to the HTTP status, then to the axios code for
 * a network failure that never got a response. The message half is
 * {@link errorMessage}, so the wording matches every other surface.
 */
export function describeApiError(error: unknown, fallback = 'Request failed'): { code: string; message: string } {
  const e =
    typeof error === 'object' && error !== null
      ? (error as { code?: unknown; response?: { status?: number; data?: { data?: { error_code?: unknown } } } })
      : null;
  const errorCode = e?.response?.data?.data?.error_code;
  const code =
    typeof errorCode === 'string'
      ? errorCode
      : String(e?.response?.status ?? (typeof e?.code === 'string' ? e.code : '') ?? '') || 'UNKNOWN';
  return { code: code || 'UNKNOWN', message: errorMessage(error, fallback) };
}

/**
 * Pull the HTTP status out of whatever a failed call threw, or 0 when there
 * isn't one (client-side error, network failure before a response).
 *
 * Same motivation as {@link errorMessage}: the axios-error shape was being
 * re-spelled at each call site that needed to branch on a status — most often
 * to absorb an expected 409. `client.ts`'s interceptor also stamps `status`
 * directly for the network-failure case, so both shapes are read here.
 */

export function errorStatus(error: unknown): number {
  const e =
    typeof error === 'object' && error !== null ? (error as { status?: number; response?: { status?: number } }) : null;
  return e?.response?.status ?? e?.status ?? 0;
}

/**
 * Did this fail because git had no credentials for the repo?
 *
 * The signature of a clone the hub ran anonymously against a repo that is not
 * public. Worth recognising rather than passing through, because the raw text is
 * about a terminal prompt and the actual situation is "you have not connected
 * GitHub" — a thing the person reading it can fix in one click, and cannot
 * possibly infer from what git wrote.
 *
 * Matched on git's own wording rather than a status code: the hub answers 400
 * for every bad clone (`clone_project` returns the driver's message verbatim),
 * so a broken URL and a missing credential arrive identically apart from this.
 *
 * `Authentication failed` is included for the credential that EXISTS but no
 * longer works — expired or revoked. Same fix, same button.
 */
export function isMissingGitCredential(error: unknown): boolean {
  const text = errorMessage(error, '').toLowerCase();
  return (
    text.includes('could not read username') ||
    text.includes('terminal prompts disabled') ||
    text.includes('authentication failed')
  );
}
