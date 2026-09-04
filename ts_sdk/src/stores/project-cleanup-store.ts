/**
 * The cleanup counts from the last project scan.
 *
 * A mirror, never a source of truth. The backend counts the candidates during
 * the scan it was already doing and ships them on the `list-projects` response;
 * this holds the last set so the footer warning can read them without a second
 * call and without a threshold of its own.
 *
 * Empty until a scan has run. That is deliberate — the warning is a *result*,
 * so it appears when the project list is fetched (the picker opening, a project
 * switch) and not before. Nothing here triggers a scan.
 *
 * Lives in the SDK rather than the app because `useWarnings` is an SDK hook and
 * cannot reach into `ui/src`.
 */

import type { CleanupSummary } from '../entities/compute-node/system-profile';
import { useSyncExternalStore } from 'react';

let summary: CleanupSummary | null = null;
const listeners = new Set<() => void>();

/** Subscribe to scan updates. Returns an unsubscribe callable. */
export function subscribeToCleanupSummary(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Single ingestion point, called with whatever `list-projects` returned.
 *
 * An older backend sends no `cleanup` block; that is not the same as "zero
 * candidates", so it leaves the last known value alone rather than clearing a
 * warning the user should still see.
 */
export function ingestCleanupSummary(next: CleanupSummary | null | undefined): void {
  if (!next) return;
  const held = summary;
  // A project list is refetched often, and notifying on an unchanged value
  // re-renders every subscriber for nothing — compare first.
  if (
    held &&
    held.empty_count === next.empty_count &&
    held.orphaned_count === next.orphaned_count &&
    held.stale_count === next.stale_count &&
    held.threshold === next.threshold
  ) {
    return;
  }
  // The held reference is replaced only on a real change, which is what makes
  // it safe as a `useSyncExternalStore` snapshot.
  summary = next;
  for (const listener of listeners) listener();
}

/** The last counts, or null when no scan has run this session. */
export function getCleanupSummary(): CleanupSummary | null {
  return summary;
}

/**
 * Whether the footer should warn. The threshold rides in the payload, so this
 * reads the backend's policy rather than keeping a second copy of it.
 */
export function shouldWarnAboutEmptyProjects(next: CleanupSummary | null): boolean {
  return !!next && next.empty_count > next.threshold;
}

/** Test seam: forget the last scan. */
export function __resetCleanupStoreForTest(): void {
  summary = null;
  listeners.clear();
}

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
