/**
 * "Is this harness actually on this machine" — the one rule, shared by every
 * surface that offers a choice of worker.
 *
 * The vocabulary is `OpenerDescriptor.warning` (see `tab_opener_types.ts`): a
 * non-null string means the harness failed its backend capability check, the
 * surface renders an `OpenerWarningBadge` on its icon, and activating it routes
 * to the Capabilities view instead of doing the thing.
 */
import { capabilityManager, HARNESS_CAPABILITY_KINDS } from '@sdk';
import { type UseCapabilityResult } from '@sdk/react/hooks';
import { useCallback, useMemo } from 'react';

import { useOptionalHarnessCapabilities } from '@src/contexts/HarnessCapabilitiesContext';
import { LAUNCHABLE_WORKERS, type WorkerType } from './worker-types';

/**
 * Worker → the field carrying its harness capability on the context.
 *
 * A ternary ladder used to stand here, and it only knew three vendors: every
 * worker that was not claude_code or codex fell through to `copilot`, so an
 * OpenCode launch reported Copilot's harness and a missing `opencode` binary
 * was never flagged. One row per vendor, like HARNESS_CAPABILITY_BY_WORKER.
 */
const HARNESS_FIELD_BY_WORKER: Record<WorkerType, 'claude' | 'codex' | 'copilot' | 'opencode'> = {
  claude_code: 'claude',
  codex: 'codex',
  copilot: 'copilot',
  opencode: 'opencode',
};

/**
 * Opener warning for a harness: set when its backend capability check ran and
 * failed. An UNCHECKED capability is not a missing one — it fails open, so a
 * harness nobody has probed yet stays fully usable.
 */
export function harnessWarning(capability: UseCapabilityResult): string | null {
  if (!capability.checked || capability.available) return null;
  return capability.result?.message ?? 'This harness is not available on this machine.';
}

export interface HarnessAvailability {
  /** Per-worker capability warning, or null when the harness is fine/unknown. */
  warnings: Record<WorkerType, string | null>;
  /**
   * Resolve every harness capability, at a seam where the user has shown
   * intent (opening the picker). Necessary because the app subscribes with
   * `autoCheck: false`: the startup discovery sweep writes `last_check`, which
   * `CapabilityManager.getResult()` does not read, so without this every
   * harness reads `checked: false` and nothing is ever flagged.
   *
   * Cheap and idempotent — `ensureChecked` dedupes in-flight calls and returns
   * immediately once a result exists, so this costs at most one probe per
   * harness per session.
   */
  probeHarnesses: () => void;
}

export function useHarnessAvailability(): HarnessAvailability {
  const harnesses = useOptionalHarnessCapabilities();

  const warnings = useMemo(() => {
    const byWorker = {} as Record<WorkerType, string | null>;
    for (const worker of LAUNCHABLE_WORKERS) {
      // No provider (isolated render) ⇒ nothing known ⇒ nothing flagged.
      const capability = harnesses?.[HARNESS_FIELD_BY_WORKER[worker]];
      byWorker[worker] = capability ? harnessWarning(capability) : null;
    }
    return byWorker;
  }, [harnesses]);

  const probeHarnesses = useCallback(() => {
    for (const kind of HARNESS_CAPABILITY_KINDS) {
      // Swallowed: an older backend without the capability API must not break
      // the picker — the same allowance `startAgenticTab` makes before a spawn.
      void capabilityManager.ensureChecked(kind).catch(() => undefined);
    }
  }, []);

  return { warnings, probeHarnesses };
}
