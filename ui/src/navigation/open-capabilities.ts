import { CapabilityKinds, ViewType } from '@sdk';
import type { WorkerType } from '@src/components/workers/worker-types';
import type { NavigationActions } from './NavigationActions';

/**
 * The capability kind that provides a worker's CLI — the frontend mirror of the
 * backend's `worker_capability_kind` (`cli_worker_base_driver.py`).
 *
 * A map rather than interpolation, because the two tokens don't coincide:
 * `claude_code` registers against `harness.claude.cli`. It was previously an
 * inline ternary in the terminal strip that simply had no `copilot` branch, so
 * a failed Copilot spawn landed on an unscoped Capabilities view.
 */
const HARNESS_KIND: Record<WorkerType, string> = {
  claude_code: CapabilityKinds.ClaudeCode,
  codex: CapabilityKinds.Codex,
  copilot: CapabilityKinds.Copilot,
};

export function harnessCapabilityKind(workerType?: WorkerType | null): string | undefined {
  return workerType ? HARNESS_KIND[workerType] : undefined;
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
