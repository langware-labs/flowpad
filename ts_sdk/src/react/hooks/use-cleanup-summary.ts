/**
 * React binding for the framework-free cleanup store.
 *
 * Lives here, not beside the state it reads: see the note in
 * `stores/project-cleanup-store` for why that module must not import React.
 */

import { useSyncExternalStore } from 'react';

import type { CleanupSummary } from '../../entities/compute-node/system-profile';
import { getCleanupSummary, subscribeToCleanupSummary } from '../../stores/project-cleanup-store';

/**
 * The last counts, re-rendering when a scan updates them.
 *
 * `useSyncExternalStore` rather than a `useState` + `useEffect` pair: one call
 * instead of two hooks, and it cannot tear during a concurrent render.
 */
export function useCleanupSummary(): CleanupSummary | null {
  return useSyncExternalStore(subscribeToCleanupSummary, getCleanupSummary, getCleanupSummary);
}
