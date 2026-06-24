import { v4 as uuidv4 } from 'uuid';

/**
 * Cross-process correlation id, minted in the renderer.
 *
 * One id per app/tab session is generated lazily on first use. It is:
 *   - attached to every backend call (``X-Trace-Id`` header on HTTP,
 *     ``trace_id`` field on the WS ``rest_api_msg``),
 *   - stamped on every captured renderer console line (persisted to the
 *     Electron log file), and
 *   - set as a Sentry tag,
 * so a single id ties together: Electron log ⟷ renderer console ⟷ backend
 * logs ⟷ worker. The backend's logging CorrelationFilter renders it as
 * ``trace=<id>`` on each line (see flow_sdk/logging_setup.py).
 *
 * Session-scoped is intentionally coarse for v1 — per-request granularity is
 * still available downstream via the WS ``message_id`` / backend ``req``
 * counter. ``setTraceId`` exists so a future change can narrow the scope to a
 * single user action without touching the call sites.
 */

let _traceId: string | null = null;

function mint(): string {
  // Short, grep-friendly, still collision-safe for a session id.
  return `t-${uuidv4().replace(/-/g, '').slice(0, 12)}`;
}

export function getTraceId(): string {
  if (_traceId === null) {
    _traceId = mint();
  }
  return _traceId;
}

export function setTraceId(id: string): void {
  _traceId = id;
}

/** Mint a fresh trace id and return it (e.g. at the start of a new session). */
export function newTraceId(): string {
  _traceId = mint();
  return _traceId;
}
