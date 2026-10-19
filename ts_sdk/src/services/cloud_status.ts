/**
 * Orthogonal login + connection status enums.
 *
 * Cloud side ("hub"): driven by the backend's HubLoginStatus and
 * HubConnectionStatus enums in flow_sdk/cloud_client/auth_status.py.
 * Local side: parallel vocabulary used by AuthManager and ConnectionManager,
 * narrower because the local server doesn't auth-reject or "verify".
 */

export type HubLoginStatus = 'logged_out' | 'logging_in' | 'logged_in' | 'login_failed';

/**
 * The one `reason` value on a LOGGED_OUT status this SDK pattern-matches on.
 * `reason` stays free text for everything else (human-readable expiry/
 * rejection explanations, mirrors the backend's `LogoutReason` in
 * `flow_sdk/cloud_client/auth_status.py`) — this only names the value that
 * means "someone else just took this machine" (FLOWPAD-2151), so
 * `_setLoggedOut` drops the entity cache and `SessionTakenOverOverlay` shows,
 * instead of a quiet sign-out.
 */
export enum LogoutReason {
  SwitchedOut = 'switched_out',
}
export type HubConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'verified'
  | 'auth_rejected'
  | 'error';

export type LocalLoginStatus = 'logged_out' | 'logging_in' | 'logged_in' | 'login_failed';
export type LocalConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface LoginSlot<S> {
  status: S;
  user: Record<string, unknown> | null;
  reason: string | null;
}

export interface ConnectionSlot<S> {
  status: S;
  error: string | null;
}

export interface CloudStatus {
  login: LoginSlot<HubLoginStatus>;
  connection: ConnectionSlot<HubConnectionStatus>;
  cloud_url: string;
}

export function makeLoginSlot<S>(status: S): LoginSlot<S> {
  return { status, user: null, reason: null };
}

export function makeConnectionSlot<S>(status: S): ConnectionSlot<S> {
  return { status, error: null };
}

/** True when the hub websocket is reachable (a good proxy for "online"). */
export function isHubConnected(status: HubConnectionStatus): boolean {
  return status === 'connected' || status === 'verified';
}
