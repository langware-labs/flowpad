import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { ConnectionState, type HubConnectionStatus, type HubLoginStatus } from '@sdk';

/**
 * The Connections table's Status column: state → word and dot. The ONE map
 * every row reads — FlowPad, the harness logins, the OAuth grants — so an
 * account, a CLI login and a grant that are all fine all say "Connected". Three
 * words for one state read as three states.
 *
 * Keyed by the enum, so a new state is a type error rather than a row that
 * silently falls through to the neutral dot.
 *
 * "Not checked" is a first-class answer, not a hedge: a harness login is not
 * persisted, so "nobody has asked" is the COMMON state after any restart, and
 * rendering it as "not connected" tells a signed-in user they are signed out
 * every time the backend restarts.
 *
 * `text` is a lazy descriptor, resolved at render: a module-level `t` would
 * freeze the boot locale's English into the column.
 */
export const STATE_VISUAL: Record<ConnectionState, { text: MessageDescriptor; dot: string }> = {
  [ConnectionState.Connected]: { text: msg`Connected`, dot: 'bg-emerald-500' },
  [ConnectionState.Disconnected]: { text: msg`Not connected`, dot: 'bg-muted-foreground/40' },
  [ConnectionState.NeedsReauth]: { text: msg`Reconnect needed`, dot: 'bg-red-500' },
  [ConnectionState.Unknown]: { text: msg`Not checked`, dot: 'bg-muted-foreground/40' },
};

/**
 * The FlowPad account's hub state, in the table's vocabulary.
 *
 * `null` = no table state says it: the login or the socket is mid-flight or
 * broken in a way the hub names better ("Connecting", "Connection error"), so the
 * row keeps the hub's own word. Both maps are exhaustive `Record`s, so a new hub
 * status is a compile error here rather than a row that quietly picks a word.
 */
const LOGIN_STATE: Record<HubLoginStatus, ConnectionState | null> = {
  logged_out: ConnectionState.Disconnected,
  logging_in: null,
  login_failed: null,
  logged_in: null, // → the connection decides
};

const HUB_CONNECTION_STATE: Record<HubConnectionStatus, ConnectionState | null> = {
  verified: ConnectionState.Connected,
  connected: ConnectionState.Connected,
  auth_rejected: ConnectionState.NeedsReauth,
  connecting: null,
  error: null,
  // Logged in, socket down: not the table's "Not connected" (which means signed
  // out) — the hub's word and its amber dot say it better.
  disconnected: null,
};

export function hubConnectionState(login: HubLoginStatus, connection: HubConnectionStatus): ConnectionState | null {
  return login === 'logged_in' ? HUB_CONNECTION_STATE[connection] : LOGIN_STATE[login];
}
