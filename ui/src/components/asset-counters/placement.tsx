import type { Deployment } from '@sdk';
import { Trans } from '@lingui/react/macro';
import type { StatusRule } from './axes';

/** A deployment is live unless its provider paused it — the rule `DeploymentBadges` paints. */
export function isLiveDeployment(deployment: Deployment): boolean {
  return deployment.status.provider_state !== 'paused';
}

type Placed = { deployments: Deployment[] };

/** Running = placed somewhere that is live; Paused = placed, but every placement is paused. */
export const isRunning = (row: Placed) => row.deployments.some(isLiveDeployment);
export const isPaused = (row: Placed) => row.deployments.length > 0 && !isRunning(row);

/** The Running / [Paused] / All status options; Paused only where the type can be paused. */
export function runPauseStatuses<T>(
  running: (item: T) => boolean,
  paused: ((item: T) => boolean) | null,
  isLoading = false,
): StatusRule<T>[] {
  return [
    { key: 'running', label: <Trans>Running</Trans>, tone: 'live', keep: running, isLoading },
    ...(paused ? [{ key: 'paused', label: <Trans>Paused</Trans>, keep: paused, isLoading }] : []),
    { key: 'all', label: <Trans>All</Trans> },
  ];
}
