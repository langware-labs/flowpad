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
  response?: { data?: { detail?: string; message?: string; data?: unknown } };
  detail?: string;
  message?: string;
}

export function errorMessage(error: unknown, fallback: string): string {
  const e = typeof error === 'object' && error !== null ? (error as ErrorEnvelope) : null;

  // The envelope is checked BEFORE `Error.message`, and the order matters: an
  // AxiosError is BOTH — an Error whose message is the useless "Request failed
  // with status code 500", carrying the server's actual explanation at
  // `response.data`. Testing `instanceof Error` first threw that away and put
  // the status line in front of the user.
  const fromEnvelope = e?.response?.data?.detail || e?.response?.data?.message;
  if (fromEnvelope) return fromEnvelope;

  if (error instanceof Error && error.message) return error.message;

  return e?.detail || e?.message || fallback;
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
    typeof error === 'object' && error !== null
      ? (error as { status?: number; response?: { status?: number } })
      : null;
  return e?.response?.status ?? e?.status ?? 0;
}

/** A launch refused because the machine can't run the chosen harness. */
export interface CapabilityFailure {
  /** Stable wire string from the backend `LaunchErrorCode` taxonomy. */
  code: string;
  /** e.g. `harness.codex.cli` — deep-links `/dock/capabilities?capability=…`. */
  capabilityKind: string | null;
  workerType: string | null;
  /** Display name of the capability, e.g. "Codex CLI". */
  name: string | null;
}

/**
 * The codes that mean "needs a human" — the backend's `LaunchHealth.CONFIG_ERROR`
 * verdicts. Retrying these unchanged cannot succeed; the user has to install or
 * sign in, which is why they get a redirect to Capabilities rather than a toast.
 */
const CONFIG_ERROR_CODES = new Set(['not_installed', 'not_authenticated', 'no_api_key']);

/**
 * Recognise a capability refusal in a failed call, or `null` for anything else.
 *
 * Note the double nesting the payload is read from: `apiClient` unwraps the
 * `{status, message, data}` envelope only on SUCCESS — the error path rethrows
 * the raw axios error, so the backend's `data` sits at `response.data.data`.
 *
 * Returning `null` for unrecognised failures is what keeps this additive: a
 * caller falls through to whatever it did before, and an older backend that
 * answers a bare 500 simply doesn't match.
 */
export function capabilityErrorFrom(error: unknown): CapabilityFailure | null {
  const e = typeof error === 'object' && error !== null ? (error as ErrorEnvelope) : null;
  const payload = e?.response?.data?.data;
  if (typeof payload !== 'object' || payload === null) return null;

  const { code, capability_kind, worker_type, name } = payload as Record<string, unknown>;
  if (typeof code !== 'string' || !CONFIG_ERROR_CODES.has(code)) return null;

  return {
    code,
    capabilityKind: typeof capability_kind === 'string' ? capability_kind : null,
    workerType: typeof worker_type === 'string' ? worker_type : null,
    name: typeof name === 'string' ? name : null,
  };
}
