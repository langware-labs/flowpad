import { ConnectionManager, Tab, type ITab } from '@sdk';
import { useEffect, useSyncExternalStore } from 'react';
import { computeReorder } from '@src/tabs/tab-order';
import { syncTabLifecycleWithTabs } from '@src/tabs/tab-lifecycle';

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

let snapshot: Tab[] = [];
const listeners = new Set<() => void>();

export function coerceTab(tab: Tab | ITab): Tab {
  if (tab instanceof Tab) return tab;
  try {
    return new Tab(tab);
  } catch {
    const fallback = Object.create(Tab.prototype) as Tab;
    Object.assign(
      fallback,
      {
        id: tab.id ?? '',
        type: Tab.type,
        pointer: '',
        target_type: null,
        target_id: null,
        visible: true,
        icon_key: null,
        worktree: false,
        name: null,
        project_id: null,
        tab_order: 0,
        last_active_at: null,
        status: null,
        is_disabled: false,
      },
      tab,
    );
    return fallback;
  }
}

function notify(): void {
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot(): Tab[] {
  return snapshot;
}

/** Imperative read for loaders / resolvers outside React. */
export function getAllTabsSnapshot(): Tab[] {
  return snapshot;
}

/** Adopt a canonical tab list directly (no fetch). */
export function applyAllTabs(tabs: Array<Tab | ITab>): void {
  snapshot = tabs.map(coerceTab);
  syncTabLifecycleWithTabs(snapshot);
  notify();
}

/** Fetch the canonical global list and adopt it. */
export async function refreshAllTabs(): Promise<Tab[]> {
  const tabs = await Tab.listAll();
  applyAllTabs(tabs);
  return tabs;
}

/** Optimistic drag preview: reorder the current tabs by a predicted id order
 *  (via the shared `computeReorder`, byte-equal to the backend), keeping each
 *  tab's resolved data. Replaced by the next `tabs-changed` refresh on drop. */
export function applyPredictedOrder(reorderId: string, afterId: string | null, beforeId: string | null): void {
  const byId = new Map(snapshot.map((t) => [t.id, t]));
  const order = computeReorder(
    snapshot.map((t) => t.id),
    reorderId,
    afterId,
    beforeId,
  );
  snapshot = order.map((id) => byId.get(id)).filter((t): t is Tab => t != null);
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
    if ((fd.element_type ?? fd.elementType) === 'tabs_changed') void refreshAllTabs();
  });
}

/** React binding: the global visible tabs. Attaches the ping once and does a
 *  one-time initial fetch (subsequent updates ride the `tabs-changed` ping). */
export function useAllTabs(): Tab[] {
  const tabs = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    attach();
    if (!loadedOnce) {
      loadedOnce = true;
      void refreshAllTabs();
    }
  }, []);
  return tabs;
}

// Backward-compat aliases for migration
export const useAllTabRows = useAllTabs;
export const refreshAllTabRows = refreshAllTabs;
export const getAllTabRowsSnapshot = getAllTabsSnapshot;
export const applyAllTabRows = applyAllTabs;
