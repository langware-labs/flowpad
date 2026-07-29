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

export function errorMessage(error: unknown, fallback: string): string {
  // The envelope is checked BEFORE `Error.message`, and the order matters: an
  // AxiosError is BOTH — an Error whose message is the useless "Request failed
  // with status code 500", carrying the server's actual explanation at
  // `response.data`. Testing `instanceof Error` first threw that away and put
  // the status line in front of the user.
  if (typeof error === 'object' && error !== null) {
    const e = error as ErrorEnvelope;
    const fromEnvelope = e.response?.data?.detail || e.response?.data?.message;
    if (fromEnvelope) return fromEnvelope;
  }

  if (error instanceof Error && error.message) return error.message;

  if (typeof error === 'object' && error !== null) {
    const e = error as ErrorEnvelope;
    return e.detail || e.message || fallback;
  }

  return fallback;
}
