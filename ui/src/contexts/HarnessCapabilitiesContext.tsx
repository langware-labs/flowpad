import { createContext, useContext, type ReactNode } from 'react';

import { CapabilityKinds } from '@sdk';
import { useCapability, type UseCapabilityResult } from '@sdk/react/hooks';

/**
 * Single owner of the Claude/Codex/Copilot harness capability subscriptions.
 *
 * Each `useCapability(kind)` adds one `'change'` listener to the
 * `capabilityManager` singleton and removes it on unmount. The harness triple
 * is needed by several surfaces at once (App warmup, both terminal strips, …),
 * so subscribing per-surface meant the same three kinds were re-subscribed
 * 3×N times — enough concurrent listeners to trip EventEmitter's default-10
 * leak heuristic. This provider subscribes to the triple exactly once and
 * hands the results to every consumer via context, keeping the manager at ~3
 * harness listeners regardless of how many surfaces read them.
 *
 * It also doubles as the startup warmer: the three `useCapability` calls
 * `ensureChecked` on mount, so consumers render from a settled snapshot.
 */
interface HarnessCapabilitiesValue {
  claude: UseCapabilityResult;
  codex: UseCapabilityResult;
  copilot: UseCapabilityResult;
}

const HarnessCapabilitiesContext = createContext<HarnessCapabilitiesValue | null>(null);

export const HarnessCapabilitiesProvider = ({ children }: { children: ReactNode }) => {
  const claude = useCapability(CapabilityKinds.ClaudeCode);
  const codex = useCapability(CapabilityKinds.Codex);
  const copilot = useCapability(CapabilityKinds.Copilot);

  // No useMemo: `useCapability` returns a fresh object every render, so the
  // three deps always change identity — a memo here would never hold. Consumers
  // re-render whenever any capability snapshot changes, which is the intent.
  const value: HarnessCapabilitiesValue = { claude, codex, copilot };

  return <HarnessCapabilitiesContext.Provider value={value}>{children}</HarnessCapabilitiesContext.Provider>;
};

/** Read the shared Claude/Codex/Copilot capability snapshots. */
export function useHarnessCapabilities(): HarnessCapabilitiesValue {
  const ctx = useContext(HarnessCapabilitiesContext);
  if (!ctx) {
    throw new Error('useHarnessCapabilities must be used within a HarnessCapabilitiesProvider');
  }
  return ctx;
}
