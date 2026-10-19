import { createContext, useContext, type ReactNode } from 'react';

import { CapabilityKinds } from '@sdk';
import { useCapability, type UseCapabilityResult } from '@sdk/react/hooks';
import { normalizeWorkerType, type WorkerType } from '@src/components/workers/worker-types';

/**
 * Single owner of the default-harness capability subscription.
 *
 * `useCapability(kind)` adds one `'change'` listener to the `capabilityManager` singleton per
 * caller, and several surfaces need the default at once (the worker pickers, the chat pane, the
 * funding chip), so this provider subscribes once and hands it to every consumer. Whether each
 * harness is INSTALLED is not read here: that is the status record (`useStatusRecord`).
 */
interface HarnessCapabilitiesValue {
  defaultHarness: UseCapabilityResult;
}

const HarnessCapabilitiesContext = createContext<HarnessCapabilitiesValue | null>(null);

export const HarnessCapabilitiesProvider = ({ children }: { children: ReactNode }) => {
  const defaultHarness = useCapability(CapabilityKinds.Harness, { autoCheck: false });
  return (
    <HarnessCapabilitiesContext.Provider value={{ defaultHarness }}>{children}</HarnessCapabilitiesContext.Provider>
  );
};

/**
 * The shared snapshot when a provider is mounted, else null.
 *
 * For components that are ALSO rendered outside the app tree (isolated
 * component tests, storybook-style renders). The throwing accessor below is the
 * right contract for surfaces that only ever live under `App`; making a shared,
 * low-level component throw when no provider is present would force every test
 * of every surface that embeds it to mount the provider — which subscribes to
 * the manager singleton and fires `capabilityManager.load()`, so each of those
 * tests would need a mocked backend. Consumers read the absence as "unknown"
 * and fail open, which is the same rule they apply to an unchecked capability.
 */
export function useOptionalHarnessCapabilities(): HarnessCapabilitiesValue | null {
  return useContext(HarnessCapabilitiesContext);
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
