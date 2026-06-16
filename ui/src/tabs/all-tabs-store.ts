import { ConnectionManager, Tab, type TabRow } from '@sdk';
import { useEffect, useSyncExternalStore } from 'react';
import { computeReorder } from '@src/tabs/tab-order';

/**
 * The single tab store: the GLOBAL visible-tab list (every kind, all projects),
 * backed by the `tab` action `list_all` and refreshed on the backend
 * `tabs-changed` ping. Every consumer reads this one source and derives its view
 * locally — the strip filters to the active project + projectless (the backend
 * `filter_for_project` rule, mirrored here), the developer sessions view takes
 * the whole list, the terminal body filters to terminal target types, and the
 * footer projects-chip buckets by `project_id`. There is no reactive entity query
 * and no second (project-scoped) store/endpoint.
 */

let snapshot: TabRow[] = [];
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot(): TabRow[] {
  return snapshot;
}

/** Imperative read for loaders / resolvers outside React. */
export function getAllTabRowsSnapshot(): TabRow[] {
  return snapshot;
}

/** Adopt a canonical row list directly (no fetch). */
export function applyAllTabRows(rows: TabRow[]): void {
  snapshot = rows;
  notify();
}

/** Fetch the canonical global list and adopt it. */
export async function refreshAllTabRows(): Promise<TabRow[]> {
  const rows = await Tab.listAll();
  applyAllTabRows(rows);
  return rows;
}

/** Optimistic drag preview: reorder the current rows by a predicted id order
 *  (via the shared `computeReorder`, byte-equal to the backend), keeping each
 *  row's resolved data. Replaced by the next `tabs-changed` refresh on drop. */
export function applyPredictedOrder(reorderId: string, afterId: string | null, beforeId: string | null): void {
  const byId = new Map(snapshot.map((r) => [r.id, r]));
  const order = computeReorder(
    snapshot.map((r) => r.id),
    reorderId,
    afterId,
    beforeId,
  );
  snapshot = order.map((id) => byId.get(id)).filter((r): r is TabRow => r != null);
  notify();
}

let attached = false;
let loadedOnce = false;
function attach(): void {
  if (attached) return;
  attached = true;
  const cm = ConnectionManager.getInstance();
  cm.on('on_flow_data', (_typeId: unknown, flowData: unknown) => {
    const fd = (flowData ?? {}) as { element_type?: string; elementType?: string };
    if ((fd.element_type ?? fd.elementType) === 'tabs_changed') void refreshAllTabRows();
  });
}

/** React binding: the global visible-tab rows. Attaches the ping once and does a
 *  one-time initial fetch (subsequent updates ride the `tabs-changed` ping). */
export function useAllTabRows(): TabRow[] {
  const rows = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    attach();
    if (!loadedOnce) {
      loadedOnce = true;
      void refreshAllTabRows();
    }
  }, []);
  return rows;
}
