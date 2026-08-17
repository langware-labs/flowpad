import { createContext, useContext, type ReactNode } from 'react';

import { CapabilityKinds } from '@sdk';
import { useCapability, type UseCapabilityResult } from '@sdk/react/hooks';
import {
  normalizeWorkerType,
  type WorkerType,
} from '@src/components/workers/worker-types';

/**
 * Single owner of the default/Claude/Codex/Copilot harness capability
 * subscriptions.
 *
 * Each `useCapability(kind)` adds one `'change'` listener to the
 * `capabilityManager` singleton and removes it on unmount. The harness set is
 * needed by several surfaces at once (App warmup, both terminal strips, …),
 * so subscribing per-surface meant the same kinds were re-subscribed N times
 * — enough concurrent listeners to trip EventEmitter's default-10 leak
 * heuristic. This provider subscribes to the set exactly once and
 * hands the results to every consumer via context, keeping the manager at ~4
 * harness listeners regardless of how many surfaces read them.
 *
 * Startup loads the persisted snapshots only. Executable harness tests are
 * intentionally on-demand at the launch/setup seams: running three external
 * probes on every page load consumed the browser's backend connection pool and
 * delayed unrelated URL loaders and asset-chat attachment by several seconds.
 */
interface HarnessCapabilitiesValue {
  defaultHarness: UseCapabilityResult;
  claude: UseCapabilityResult;
  codex: UseCapabilityResult;
  copilot: UseCapabilityResult;
  opencode: UseCapabilityResult;
}

const HarnessCapabilitiesContext = createContext<HarnessCapabilitiesValue | null>(null);

export const HarnessCapabilitiesProvider = ({ children }: { children: ReactNode }) => {
  const defaultHarness = useCapability(CapabilityKinds.Harness, { autoCheck: false });
  const claude = useCapability(CapabilityKinds.ClaudeCode, { autoCheck: false });
  const codex = useCapability(CapabilityKinds.Codex, { autoCheck: false });
  const copilot = useCapability(CapabilityKinds.Copilot, { autoCheck: false });
  const opencode = useCapability(CapabilityKinds.OpenCode, { autoCheck: false });

  // No useMemo: `useCapability` returns a fresh object every render, so the
  // five deps always change identity — a memo here would never hold. Consumers
  // re-render whenever any capability snapshot changes, which is the intent.
  const value: HarnessCapabilitiesValue = { defaultHarness, claude, codex, copilot, opencode };

  return <HarnessCapabilitiesContext.Provider value={value}>{children}</HarnessCapabilitiesContext.Provider>;
};

/** Read the shared Claude/Codex/Copilot/OpenCode capability snapshots. */
export function useHarnessCapabilities(): HarnessCapabilitiesValue {
  const ctx = useContext(HarnessCapabilitiesContext);
  if (!ctx) {
    throw new Error('useHarnessCapabilities must be used within a HarnessCapabilitiesProvider');
  }
  return ctx;
}

/**
 * Project the persisted `harness` capability reference into the worker value
 * rendered by selectors. Process creation still resolves the default on the
 * backend; this hook only keeps the UI's initial selection in sync.
 *
 * The fallback keeps isolated component tests and pre-bootstrap renders
 * deterministic. It is never sent implicitly by worker-less launch paths.
 */
export function useDefaultWorkerType(): WorkerType {
  const ctx = useContext(HarnessCapabilitiesContext);
  return normalizeWorkerType(ctx?.defaultHarness.resolvedWorkerType);
}
