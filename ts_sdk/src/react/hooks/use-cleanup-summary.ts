/**
 * React binding for the framework-free cleanup store.
 *
 * Deliberately NOT in `stores/project-cleanup-store` beside the state it reads:
 * that module is re-exported from the SDK barrel, and the barrel is served to
 * non-React consumers as `/sdk/flowpad-sdk.js`. A single `import … from 'react'`
 * anywhere in its graph makes the built bundle carry a BARE specifier, which a
 * plain static page cannot resolve — every `template-flowpad` app died on
 * "Failed to resolve module specifier react" before the hook moved here. Same
 * rule, and same reason, as the `react/FlowIcon` note in `src/index.ts`.
 */

import { useSyncExternalStore } from 'react';

import type { CleanupSummary } from '../../entities/compute-node/system-profile';
import { getCleanupSummary, subscribeToCleanupSummary } from '../../stores/project-cleanup-store';

/**
 * The last counts, re-rendering when a scan updates them.
 *
 * `useSyncExternalStore` rather than a `useState` + `useEffect` pair, matching
 * every sibling store (`activity-store`, `pending-actions-store`): it is one
 * call instead of two hooks, and it cannot tear during a concurrent render.
 */
export function useCleanupSummary(): CleanupSummary | null {
  return useSyncExternalStore(subscribeToCleanupSummary, getCleanupSummary, getCleanupSummary);
}
