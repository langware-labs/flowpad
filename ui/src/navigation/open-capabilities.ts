import { ViewType } from '@sdk';
import { HARNESS_CAPABILITY_BY_WORKER, type WorkerType } from '@src/components/workers/worker-types';
import type { NavigationActions } from './NavigationActions';

/**
 * The capability kind that provides a worker's CLI — the frontend mirror of the
 * backend's `worker_capability_kind` (`cli_worker_base_driver.py`).
 *
 * Read from the ONE vendor table (`HARNESS_CAPABILITY_BY_WORKER`) rather than a
 * second copy here: the tokens don't coincide (`claude_code` registers against
 * `harness.claude.cli`), and the local copy had gone stale exactly the way the
 * ternary it replaced did — it was missing `opencode`, so a failed OpenCode
 * spawn landed on an unscoped Capabilities view.
 */
export function harnessCapabilityKind(workerType?: WorkerType | null): string | undefined {
  return workerType ? HARNESS_CAPABILITY_BY_WORKER[workerType] : undefined;
}

/**
 * THE way a failed "start a session" lands the user somewhere useful.
 *
 * A failed create is overwhelmingly the chosen harness missing from this
 * machine, which a toast could only describe. Capabilities re-probes the kind
 * it arrives with, so scoping the open to the worker the user actually picked
 * is what corrects the stale row and offers that harness's install — an
 * unscoped open probes nothing.
 */
export function openCapabilitiesForWorker(
  navigation: Pick<NavigationActions, 'openTab'>,
  workerType?: WorkerType | null,
): void {
  const capabilityKind = harnessCapabilityKind(workerType);
  navigation.openTab(ViewType.CAPABILITIES, capabilityKind ? { capabilityKind } : undefined);
}
