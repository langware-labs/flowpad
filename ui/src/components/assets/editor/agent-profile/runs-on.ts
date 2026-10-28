import type { AgentPlace } from '@sdk';

/**
 * Where a schedule runs: this computer, one of the agent's cloud machines (a local row with `runs_on`), or
 * Flowpad cloud (a hub Trigger). Only Flowpad cloud is another store from this computer's; crossing that
 * line is a move — a delete where it is plus a create where it goes.
 */
export type RunsOn =
  | { kind: 'local'; deploymentId?: string | null }
  | { kind: 'cloud_machine'; deploymentId: string }
  | { kind: 'hub' };

export function runsOnKey(value: RunsOn): string {
  if (value.kind === 'hub') return 'hub';
  if (value.kind === 'cloud_machine') return `deployment:${value.deploymentId}`;
  return 'local';
}

/** Whether going from one place to another changes store (local ↔ hub): saved as a delete plus a create. */
export const isMove = (from: RunsOn, to: RunsOn): boolean => (from.kind === 'hub') !== (to.kind === 'hub');

/** The place a local row with `runs_on` is on, read against the agent's places. */
export function runsOnOf(runsOn: string | null | undefined, places: AgentPlace[]): RunsOn {
  const place = runsOn ? places.find((p) => p.deployment.id === runsOn) : undefined;
  if (place && !place.is_local) return { kind: 'cloud_machine', deploymentId: place.deployment.id };
  return { kind: 'local', deploymentId: runsOn ?? null };
}
