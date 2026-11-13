import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';

/**
 * The ONE state vocabulary every item (agent, machine, deployment, issue, channel…) is read in,
 * on every surface. Each kind maps its own field onto it; the words and tones live only here, so
 * "Live", "Active" and "Idle" can never come back as three names for one thing.
 */
export type ItemState = 'running' | 'paused' | 'starting' | 'attention' | 'error' | 'resolved' | 'off';

export type StateTone = 'success' | 'warning' | 'danger' | 'info' | 'muted';

export const ITEM_STATES: Record<ItemState, { label: MessageDescriptor; tone: StateTone }> = {
  running: { label: msg`Running`, tone: 'success' },
  paused: { label: msg`Paused`, tone: 'warning' },
  starting: { label: msg`Starting`, tone: 'info' },
  attention: { label: msg`Needs attention`, tone: 'warning' },
  error: { label: msg`Open`, tone: 'danger' },
  resolved: { label: msg`Resolved`, tone: 'muted' },
  off: { label: msg`Not deployed`, tone: 'muted' },
};

/** A deployment's provider-reported state. `planned` is on its way up, never "Live". */
export function deploymentState(providerState: string | null | undefined): ItemState {
  switch ((providerState ?? '').toLowerCase()) {
    case 'running':
    case 'ready':
      return 'running';
    case 'paused':
    case 'stopped':
    case 'suspended':
      return 'paused';
    case 'planned':
    case 'pending':
    case 'provisioning':
    case 'starting':
      return 'starting';
    case 'error':
    case 'failed':
      return 'attention';
    default:
      return 'off';
  }
}

/** A deployment row's state: a local one runs while it serves its main agent (its provider never reports
 *  anything but `configured`); a remote one is what its provider says. */
export function deploymentRowState(d: {
  isLocal: boolean;
  serving?: boolean;
  status?: { provider_state?: string | null } | null;
}): ItemState {
  if (d.isLocal && (d.status?.provider_state ?? 'configured') === 'configured') return d.serving ? 'running' : 'off';
  return deploymentState(d.status?.provider_state);
}

/** An issue: open errors and warnings both ask for you; resolved ones do not. */
export function issueState(status: string | null | undefined, severity: string | null | undefined): ItemState {
  if (status === 'resolved' || status === 'closed') return 'resolved';
  return severity === 'error' ? 'error' : 'attention';
}

/** An agent: not deployed anywhere is off; else running when any placement runs. */
export function agentState(deployed: boolean, running: boolean): ItemState {
  if (!deployed) return 'off';
  return running ? 'running' : 'paused';
}

/** A channel claim: active answers, pending waits for its code, lapsed stopped. */
export function channelState(status: 'pending' | 'active' | 'lapsed'): ItemState {
  return status === 'active' ? 'running' : status === 'pending' ? 'attention' : 'paused';
}
