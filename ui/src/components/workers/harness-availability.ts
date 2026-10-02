/**
 * "Is this harness actually on this machine" — read off the status record, shared by every
 * surface that offers a choice of worker.
 *
 * The vocabulary is `OpenerDescriptor.warning` (see `tab_opener_types.ts`): a non-null string
 * means the harness is not installed, the surface renders an `OpenerWarningBadge` on its icon,
 * and activating it routes to the Capabilities view instead of doing the thing.
 *
 * Installed is Python's fact (`flow_sdk/core/status`, swept at boot and after every install,
 * pushed on change); nothing here probes. `unknown` — the sweep has not finished — is not
 * missing: it fails open, so a harness nobody has looked at yet stays usable.
 */
import { type HarnessStatus, InstallState, type StatusRecord } from '@sdk';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { useMemo } from 'react';

import { harnessStatus, useStatusRecord } from '@src/components/status/use-status-record';
import { HARNESS_CAPABILITY_BY_WORKER, LAUNCHABLE_WORKERS, type WorkerType } from './worker-types';

/** The opener warning for one harness: set only when the record says it is not installed. */
export function installWarning(harness: HarnessStatus | undefined): string | null {
  if (harness?.install !== InstallState.NotInstalled) return null;
  return i18n._(msg`${harness.label} is not installed on this machine.`);
}

/** The warning for a worker, looked up by its capability kind in `record`. */
export function workerInstallWarning(record: StatusRecord | null | undefined, worker: WorkerType): string | null {
  return installWarning(harnessStatus(record, HARNESS_CAPABILITY_BY_WORKER[worker]));
}

export interface HarnessAvailability {
  /** Per-worker install warning, or null when the harness is installed or not yet known. */
  warnings: Record<WorkerType, string | null>;
}

export function useHarnessAvailability(): HarnessAvailability {
  const { status: record } = useStatusRecord();
  const warnings = useMemo(() => {
    const byWorker = {} as Record<WorkerType, string | null>;
    for (const worker of LAUNCHABLE_WORKERS) byWorker[worker] = workerInstallWarning(record, worker);
    return byWorker;
  }, [record]);
  return { warnings };
}
