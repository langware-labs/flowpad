import { t } from '@lingui/core/macro';

import { notify } from '@src/notifications/notify';

/** sessionStorage key: the outcome a load-time resolver could not toast yet. */
export const AGENT_AUTO_LAUNCH_WARNING_KEY = 'flowpad.agent-auto-launch.warning';

export interface AgentAutoLaunchWarning {
  winner: string;
  cancelled: string[];
}

/**
 * Stash the "others were cancelled" outcome for the next render.
 *
 * The auto-launch resolver runs inside a router loader on a cold load, before
 * `NotificationOutlet` is mounted and before the redirect it returns has
 * landed — a toast fired there is lost. So the loader writes, and `App`
 * flushes once mounted. sessionStorage, not memory: the redirect is a real
 * navigation and a module-level slot would not survive a full reload.
 */
export function stashAgentAutoLaunchWarning(warning: AgentAutoLaunchWarning): void {
  try {
    sessionStorage.setItem(AGENT_AUTO_LAUNCH_WARNING_KEY, JSON.stringify(warning));
  } catch {
    // Storage unavailable (private mode / sandboxed frame): the warning is lost,
    // never the launch.
  }
}

/** Read-and-clear; null when nothing is pending. */
export function takeAgentAutoLaunchWarning(): AgentAutoLaunchWarning | null {
  try {
    const raw = sessionStorage.getItem(AGENT_AUTO_LAUNCH_WARNING_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(AGENT_AUTO_LAUNCH_WARNING_KEY);
    const parsed = JSON.parse(raw) as Partial<AgentAutoLaunchWarning>;
    if (!parsed || typeof parsed.winner !== 'string' || !Array.isArray(parsed.cancelled)) return null;
    return { winner: parsed.winner, cancelled: parsed.cancelled.map(String) };
  } catch {
    return null;
  }
}

/**
 * Surface the pending warning, if any. `forceToast`: a cancelled auto-launch
 * is otherwise a silent no-op the author would never see outside Dev mode —
 * the alert store copy still lands in the footer warnings list either way.
 */
export function flushAgentAutoLaunchWarning(): void {
  const warning = takeAgentAutoLaunchWarning();
  if (!warning || warning.cancelled.length === 0) return;
  const names = warning.cancelled.join(', ');
  notify.warning({
    id: 'agent-auto-launch-cancelled',
    forceToast: true,
    title: t`${warning.winner} auto-launched`,
    message: t`Auto-launch cancelled for: ${names}. Only the oldest agent launches on project open.`,
  });
}
