import { ConnectionManager, Tab, type BroadcastMessage, type ITab } from '@sdk';
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
        parent_tab_id: null,
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

/** Adopt a canonical tab list directly (no fetch). `tabs` MUST be the UNSCOPED
 *  global list (every project) — the `Tab.listAll()` projection, never a
 *  project-scoped `Tab.list`/`new_tab` result. Adopting a single-project slice
 *  here erases every other project's tabs from the global snapshot (the footer
 *  projects-chip then collapses to one project). */
export function applyAllTabs(tabs: Array<Tab | ITab>): void {
  snapshot = tabs.map(coerceTab);
  syncTabLifecycleWithTabs(snapshot);
  notify();
}

let refreshInFlight: Promise<Tab[]> | null = null;
let refreshRequestedAgain = false;

/** Fetch the canonical global list and adopt it. Concurrent calls coalesce onto
 *  one in-flight fetch: a burst of `tabs_changed` pings (e.g. close-all fires
 *  one broadcast per tab) costs at most two `list_all` round-trips — the one in
 *  flight plus a single trailing refetch — and responses can never land
 *  out of order and overwrite a newer snapshot with an older list. Callers
 *  joining mid-flight resolve after the trailing refetch, so they always
 *  observe state at least as fresh as their call. */
export function refreshAllTabs(): Promise<Tab[]> {
  if (refreshInFlight) {
    refreshRequestedAgain = true;
    return refreshInFlight;
  }
  refreshInFlight = (async () => {
    try {
      let tabs = await Tab.listAll();
      applyAllTabs(tabs);
      while (refreshRequestedAgain) {
        refreshRequestedAgain = false;
        tabs = await Tab.listAll();
        applyAllTabs(tabs);
      }
      return tabs;
    } finally {
      refreshInFlight = null;
      refreshRequestedAgain = false;
    }
  })();
  return refreshInFlight;
}

function refreshAllTabsInBackground(): void {
  // The API client already reports transport failures. Background consumers
  // own the rejection so an unavailable backend cannot escape as an unhandled
  // promise; explicit callers of refreshAllTabs still receive the rejection.
  void refreshAllTabs().catch(() => undefined);
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
/** Subscribe the store to the backend's global `tabs_changed` ping (a
 *  `broadcast` WS message — see `broadcast_tabs_changed` in
 *  `flow_sdk/builtin/tab.py`). Idempotent; exported so non-React consumers
 *  (tests) can drive the real reactivity path. */
export function attachTabsChangedPing(): void {
  if (attached) return;
  attached = true;
  const cm = ConnectionManager.getInstance();
  cm.on('on_broadcast', (msg: BroadcastMessage) => {
    if (msg?.broadcast_type === 'tabs_changed') refreshAllTabsInBackground();
  });
}

/** React binding: the global visible tabs. Attaches the ping once and does a
 *  one-time initial fetch (subsequent updates ride the `tabs-changed` ping). */
export function useAllTabs(): Tab[] {
  const tabs = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    attachTabsChangedPing();
    if (!loadedOnce) {
      loadedOnce = true;
      refreshAllTabsInBackground();
    }
  }, []);
  return tabs;
}

// Backward-compat aliases for migration
export const useAllTabRows = useAllTabs;
export const refreshAllTabRows = refreshAllTabs;
export const getAllTabRowsSnapshot = getAllTabsSnapshot;
export const applyAllTabRows = applyAllTabs;
