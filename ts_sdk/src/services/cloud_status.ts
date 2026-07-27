/**
 * Orthogonal login + connection status enums.
 *
 * Cloud side ("hub"): driven by the backend's HubLoginStatus and
 * HubConnectionStatus enums in flow_sdk/cloud_client/auth_status.py.
 * Local side: parallel vocabulary used by AuthManager and ConnectionManager,
 * narrower because the local server doesn't auth-reject or "verify".
 */

export type HubLoginStatus = 'logged_out' | 'logging_in' | 'logged_in' | 'login_failed';
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
