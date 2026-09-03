import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { HubConnectionStatus, HubLoginStatus } from '@sdk';
import { AlertCircle, CheckCircle2, Cloud, CloudOff, Loader2 } from 'lucide-react';

/**
 * How a hub login/connection state LOOKS — one table, for every surface.
 *
 * Extracted from `user-info.tsx` when the Connections table grew a FlowPad row:
 * two surfaces reporting the same two enums had started to drift on the wording
 * (`logged_out` read "Logged out" in one place and "Not connected" in the
 * other), and the second copy was an if-ladder, so a new `HubConnectionStatus`
 * would have fallen through it silently instead of failing to compile.
 *
 * `text` is a lazy {@link MessageDescriptor}, not a string: these maps are
 * module-level, so a `t` macro here would freeze the boot locale's wording, and
 * a `<Trans>{visual.text}</Trans>` extracts as the placeholder-only message
 * `{0}` — the badge printed raw English through a translated app. Resolve it at
 * render with `i18n._`, which is also what re-reads it after a locale switch.
 */
export type BadgeVisual = {
  text: MessageDescriptor;
  variant: 'destructive' | 'secondary' | 'outline';
  icon: typeof Loader2;
  iconClassName?: string;
};

export const LOGIN_VISUAL: Record<HubLoginStatus, BadgeVisual> = {
  logged_in: { text: msg`Logged in`, variant: 'secondary', icon: CheckCircle2 },
  logging_in: { text: msg`Signing in`, variant: 'outline', icon: Loader2, iconClassName: 'animate-spin' },
  login_failed: { text: msg`Login failed`, variant: 'destructive', icon: AlertCircle },
  logged_out: { text: msg`Logged out`, variant: 'outline', icon: CloudOff },
};

export const CONNECTION_VISUAL: Record<HubConnectionStatus, BadgeVisual> = {
  verified: { text: msg`Connection verified`, variant: 'secondary', icon: CheckCircle2 },
  connected: { text: msg`Connected`, variant: 'outline', icon: Cloud },
  connecting: { text: msg`Connecting`, variant: 'outline', icon: Loader2, iconClassName: 'animate-spin' },
  auth_rejected: { text: msg`Connection rejected`, variant: 'destructive', icon: AlertCircle },
  error: { text: msg`Connection error`, variant: 'destructive', icon: AlertCircle },
  disconnected: { text: msg`Not connected`, variant: 'outline', icon: CloudOff },
};

/**
 * The one state word for a hub account: what the CONNECTION is doing once you
 * are logged in, and what the LOGIN is doing before that.
 */
export function hubStatusVisual(
  login: HubLoginStatus,
  connection: HubConnectionStatus,
): BadgeVisual {
  return login === 'logged_in' ? CONNECTION_VISUAL[connection] : LOGIN_VISUAL[login];
}
