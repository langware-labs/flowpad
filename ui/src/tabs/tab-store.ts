import { ConnectionManager, Tab, type TabRow } from '@sdk';
import { useEffect, useSyncExternalStore } from 'react';
import { computeReorder } from '@src/tabs/tab-order';

/**
 * The single render source for the tab strip.
 *
 * Order is backend-owned (flow_sdk/builtin/tab.py): the strip renders exactly the
 * rows the `list`/`new_tab`/`order`/`close` actions return — it never re-derives
 * order from entities, and there is no reactive `Tab` query. This module holds the
 * CURRENT project view (a project's tabs + projectless tabs, in global order) and
 * refreshes it on three triggers:
 *   1. the active project changes (`setProject` via `useTabRows`),
 *   2. an action returns a fresh canonical list (`applyRows`),
 *   3. the backend `tabs-changed` ping fires (background death / rename / 2nd
 *      window) → `refresh()`.
 *
 * During a drag, `applyPredictedOrder` paints the optimistic drop locally
 * (mirroring the backend algebra via `computeReorder`); the action's returned
 * list then replaces it — or `refresh()` restores truth on error.
 */

let snapshot: TabRow[] = [];
let currentProject: string | null = null;
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

function setRows(rows: TabRow[]): void {
  snapshot = rows;
  notify();
}

/** Imperative read for loaders / resolvers outside React. */
export function getTabRowsSnapshot(): TabRow[] {
  return snapshot;
}

/** Fetch the canonical list for `projectId` (defaults to the active project) and
 *  adopt it — unless the active project changed underneath us (race guard). */
export async function refresh(projectId: string | null = currentProject): Promise<TabRow[]> {
  currentProject = projectId;
  const rows = await Tab.list(projectId);
  if (projectId === currentProject) setRows(rows);
  return rows;
}

/** Adopt the canonical list an action just returned (no extra round-trip). */
export function applyRows(rows: TabRow[], projectId: string | null = currentProject): void {
  currentProject = projectId;
  setRows(rows);
}

/** Point the store at a project; refetch only when it actually changes. */
export function setProject(projectId: string | null): void {
  if (projectId !== currentProject) void refresh(projectId);
}

/** Optimistic drag preview: reorder the current rows by a predicted id order
 *  (computed via the shared `computeReorder`), keeping every row's resolved data.
 *  Replaced by the backend's returned list on drop. */
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
function attachPing(): void {
  if (attached) return;
  attached = true;
  const cm = ConnectionManager.getInstance();
  cm.on('on_flow_data', (_typeId: unknown, flowData: unknown) => {
    const fd = (flowData ?? {}) as { element_type?: string; elementType?: string };
    if ((fd.element_type ?? fd.elementType) === 'tabs_changed') void refresh();
  });
}

/** React binding: the ordered rows for `projectId`. Attaches the ping once and
 *  keeps the store pointed at the active project. */
export function useTabRows(projectId: string | null): TabRow[] {
  const rows = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    attachPing();
    setProject(projectId);
  }, [projectId]);
  return rows;
}
