import { Tab, TabLifecycleState, tabForDockKey, tabKey, tabManager, toplog } from '@sdk';
import { isHubOnly } from '@src/navigation/hub-runtime';
import { DockPointer } from '@src/navigation/DockPointer';
import { isContentAssetDock } from '@src/navigation/content-asset-dock';
import { isAdoptableChildDock } from '@src/navigation/adoptable-child-dock';
import { ViewType } from '@src/types/ViewType';

export interface TabSetupResult {
  tab: Tab | null;
  tabs?: Tab[];
  error?: unknown;
}

export interface TabContentAdapter {
  setupTab(dock: DockPointer): Promise<TabSetupResult>;
  cleanupTab(dock: DockPointer, tab: Tab): Promise<void>;
}

export interface SetupTabOptions {
  setupContent?: () => Promise<void>;
  adapter?: TabContentAdapter;
  onMaterialized?: (tabs: Tab[]) => void;
  /** Explicit workspace parent for a mounted-view adoption pass. */
  parentTabId?: string | null;
}

const setupInFlight = new Map<string, Promise<TabSetupResult>>();

const defaultAdapter: TabContentAdapter = {
  setupTab: () => Promise.resolve({ tab: null }),
  cleanupTab: () => Promise.resolve(),
};

const adapters = new Map<string, TabContentAdapter>();

function isRedirectResponse(error: unknown): boolean {
  if (typeof Response !== 'undefined' && error instanceof Response) {
    return error.status >= 300 && error.status < 400 && error.headers.has('Location');
  }
  const candidate = error as { status?: number; headers?: { get?: (name: string) => string | null } } | null;
  return !!(
    candidate &&
    typeof candidate.status === 'number' &&
    candidate.status >= 300 &&
    candidate.status < 400 &&
    candidate.headers?.get?.('Location')
  );
}

function shouldMaterializeDock(dock: DockPointer): boolean {
  // Hub mode runs ephemeral: the hub backend has no `tab` entity, so never
  // materialize a persisted dock. Views render directly from the DockPointer.
  if (isHubOnly()) return false;
  if (!dock.tabHash) return false;
  if (dock.viewType === ViewType.AGENTIC_PROCESS) return false;
  return !(dock.viewType === ViewType.SHELL && dock.pointer === 'new_terminal');
}

async function materializeTab(
  dock: DockPointer,
  options: SetupTabOptions,
): Promise<{ tab: Tab | null; tabs: Tab[] }> {
  const t0 = performance.now();
  const existing = await tabManager.listAll();
  toplog.log(
    'process_load',
    `materializeTab tabManager.listAll took ${(performance.now() - t0).toFixed(1)}ms (${existing.length} tabs) dock=${dock.tabHash}`,
  );
  const existingTab = tabForDockKey(existing, dock.tabHash);
  // A workspace surface (the vibe workspace) may have registered its process
  // tab as the parent for tabs materialized right now. Only workspace CONTENT
  // is adoptable — content assets/files and a plain terminal (a shell opened
  // from inside the workspace belongs in its display, like a file). A
  // process/project/assets-list dock is a navigation *away* from the workspace
  // (its loader runs before the workspace unmounts and clears the slot), and
  // adopting those was how nested-workspace / process-under-process corruption
  // arose. This is the ONLY grouping seam; no navigation call site knows about
  // children, and the backend enforces the same invariant
  // (`_PARENT_FORBIDDEN_TARGET_TYPES` + `_pointer_is_adoptable_child`) as the
  // second belt. An adoptable tab takes a parent registered by a mounted
  // workspace or supplied by its mounted-view adoption pass. Process
  // lookup/creation is not awaited here: route loaders must stay fast, so
  // AssetVibeWorkspace resolves that side effect after the URL-owned asset
  // view mounts.
  const addressesAdoptable = isAdoptableChildDock(dock);
  const parentTabId = addressesAdoptable
    ? (options.parentTabId ?? hostTabIdFromDock(dock) ?? tabManager.getActiveParentTabId())
    : null;
  // Mirror the backend's self-parent guard: a tab can never adopt itself, and
  // would otherwise re-resolve on every return navigation forever.
  const needsReparent =
    !!parentTabId && !!existingTab && existingTab.id !== parentTabId && existingTab.parent_tab_id !== parentTabId;
  // Re-parenting an already-resolved asset must not resolve/download that same
  // entity a second time. On a live editor the entity ref can be FETCHING for
  // viewer work, which made `getFromDockPointer` queue behind it and left the
  // Vibe transition half-open. The existing Tab already carries the exact
  // denormalized target/project metadata; send it through the same backend
  // `new_tab` ensure seam with only the new parent edge.
  if (needsReparent && existingTab?.pointer) {
    await tabManager.newTab(existingTab.pointer, {
      targetType: existingTab.target_type,
      targetId: existingTab.target_id,
      projectId: existingTab.project_id,
      name: existingTab.name,
      iconKey: existingTab.icon_key,
      worktree: existingTab.worktree,
      parentTabId,
    });
    const all = await tabManager.listAll();
    return { tab: tabForDockKey(all, dock.tabHash) ?? existingTab, tabs: all };
  }
  // Inverse of the adopt guard: a NON-adoptable dock must never CARRY a parent
  // either. A stale edge persisted onto e.g. an assets-list row (written under
  // the retired display-tab model, before the adoptable allow-list) resurrects
  // a vibe workspace around a top-level surface on every reuse — the rail's
  // project button re-opened the last process (RCA 2026-07-16). Falls through
  // to the mint below, where the backend (`ensure_tab`'s adoptable-pointer
  // guard) null-heals the row — same self-heal seam as its stale siblings.
  const staleParentEdge = !!existingTab?.parent_tab_id && !addressesAdoptable;
  // A lens dock can't trust the row's denormalized project_id: the loader
  // activates the TARGET entity's project on every load, and the indexer may
  // re-stamp that target through the disk→DB path (`sync_to_db`), which skips
  // the backend tab reconcile — so a reused snapshot goes stale and the strip
  // (which filters tabs by `project_id === activeProject`) hides the very tab
  // being shown ("no selected tab", RCA 2026-07-14). Re-check the row against
  // the SAME resolution `getFromDockPointer` persists (one cache-first target
  // GET, which also pre-warms the lens loader's own fetch): on agreement reuse
  // as usual; on drift fall through to the full mint, which re-derives and
  // self-heals the row.
  const lensProjectStale =
    dock.viewType === ViewType.LENS &&
    !!existingTab &&
    (await tabManager.resolveDockTarget(dock)).projectId !== (existingTab.project_id ?? null);
  // Reuse an existing tab verbatim EXCEPT a project-less content tab (see the
  // project self-heal below), a stale lens tab (above), one that needs
  // re-parenting into the active workspace, or one carrying a stale parent
  // edge. All four fall through to `getFromDockPointer`, which re-derives
  // project_id from the asset and adopts (or sheds) the parent, self-healing
  // the row.
  //
  // The project self-heal is ASSET-scoped, not adoptable-scoped: a shell's
  // project_id is pinned at creation from the active project, never derived
  // from a target, and a project-less shell is a legitimate GLOBAL terminal.
  // Widening this to every adoptable dock would re-mint those on every single
  // navigation chasing a project_id that is correctly null.
  if (
    existingTab &&
    !lensProjectStale &&
    (existingTab.project_id || !isContentAssetDock(dock)) &&
    !needsReparent &&
    !staleParentEdge
  ) {
    return { tab: existingTab, tabs: existing };
  }

  toplog.log('process_load', `materializeTab cache-miss → new_tab round trip dock=${dock.tabHash}`);
  // Create-or-resolve the dock's tab. `getFromDockPointer` → `new_tab` returns
  // one PROJECT-SCOPED list (exactly that project, or Global), which must NEVER be
  // adopted into the manager's GLOBAL snapshot from the scoped response:
  // doing so erases every other project's tabs, collapsing the
  // footer projects-chip to a single project. Use the scoped list only to find
  // the materialized tab, then re-read the UNSCOPED global list for adoption.
  const scoped = await tabManager.ensureDock(dock, { parentTabId });
  const scopedTab = tabForDockKey(scoped, dock.tabHash);

  const all = await tabManager.listAll();
  const tab = tabForDockKey(all, dock.tabHash) ?? scopedTab;
  return { tab, tabs: all };
}

/**
 * The tab id of the workspace this dock's URL says is hosting it, or null.
 *
 * A pure lookup in the already-loaded tab store — no network, so it is safe on
 * the loader path. This is the URL-first replacement for reading the ambient
 * `activeParentTabId` slot: the host is a fact the caller spelled out, not one
 * inferred from whatever workspace happened to be mounted when the loader ran.
 *
 * Null when the URL names no host, or when the host's own tab is not open yet
 * (a cold open from a shared link) — the caller falls back, and the mounted
 * workspace's adoption pass still stamps the edge.
 */
function hostTabIdFromDock(dock: DockPointer): string | null {
  const host = dock.hostProcessId;
  if (!host) return null;
  const hostKey = DockPointer.forShell(host).tabHash;
  return tabForDockKey(tabManager.getSnapshot(), hostKey)?.id ?? null;
}

function adapterFor(dock: DockPointer, options: SetupTabOptions): TabContentAdapter {
  if (options.setupContent) {
    const cleanupAdapter = options.adapter ?? defaultAdapter;
    return {
      async setupTab() {
        await options.setupContent?.();
        return { tab: null };
      },
      cleanupTab: (cleanupDock, tab) => cleanupAdapter.cleanupTab(cleanupDock, tab),
    };
  }
  return options.adapter ?? adapters.get(dock.viewType ?? '') ?? defaultAdapter;
}

export function registerTabContentAdapter(viewType: string, adapter: TabContentAdapter): void {
  adapters.set(viewType, adapter);
}

export function unregisterTabContentAdapter(viewType: string): void {
  adapters.delete(viewType);
}

export async function setupTab(dock: DockPointer, options: SetupTabOptions = {}): Promise<TabSetupResult> {
  const key = dock.tabHash;
  const adapter = adapterFor(dock, options);

  if (!key || !shouldMaterializeDock(dock)) {
    return adapter.setupTab(dock);
  }

  // A content asset that is already open can change presentation options
  // (notably Standard → Vibe) without re-listing/re-minting the same Tab.
  // The route loader still runs its content adapter — and therefore remains
  // the context writer — while the durable tab identity and recency stamp are
  // reused locally. Explicit parent adoption must pass through materializeTab.
  //
  // Deliberately the ASSET predicate, not the adoptable one: this skip exists
  // for the presentation morph on a live editor, where re-minting would queue
  // behind a FETCHING entity ref. A shell dock has no such morph, and routing
  // it through materializeTab on every navigation is exactly what re-asserts
  // its workspace adoption when it is reopened from inside the workspace.
  const opened = tabManager.lifecycle.get(key);
  if (
    isContentAssetDock(dock) &&
    opened?.state === TabLifecycleState.Opened &&
    opened.tabId &&
    options.parentTabId === undefined
  ) {
    tabManager.lifecycle.set(key, TabLifecycleState.Opening, { tabId: opened.tabId });
    void tabManager.activate(opened.tabId).catch(() => {});
    try {
      await adapter.setupTab(dock);
      tabManager.lifecycle.set(key, TabLifecycleState.Opened, { tabId: opened.tabId });
      return { tab: null };
    } catch (error) {
      tabManager.lifecycle.set(key, TabLifecycleState.OpenFailed, {
        tabId: opened.tabId,
        error,
      });
      return { tab: null, error };
    }
  }

  // Materialization is keyed by tab identity, not presentation options. A
  // rapid Standard → Vibe transition can arrive while the initial asset tab is
  // still opening; sharing that work avoids two concurrent writes to the same
  // scoped tab. Vibe's process attachment/reparent is a mounted-view effect and
  // therefore does not depend on a second loader materialization.
  const inFlight = setupInFlight.get(key);
  if (inFlight) return inFlight;

  const promise = (async (): Promise<TabSetupResult> => {
    tabManager.lifecycle.set(key, TabLifecycleState.Opening);
    let tab: Tab | null = null;
    let tabs: Tab[] = [];
    try {
      const materialized = await materializeTab(dock, options);
      tab = materialized.tab;
      tabs = materialized.tabs;
      if (!tab) {
        throw new Error('Tab could not be materialized for this URL.');
      }
      tabManager.lifecycle.set(key, TabLifecycleState.Opening, { tabId: tab.id });
      // Stamp recency on EVERY tab landing, not just terminals: `last_active_at`
      // is what scope-entry (project switching) reads as "the last tab open in
      // this project", so browse/content tabs (project, assets, plan, …) must
      // record selection too — the shell/process loaders' own stamp covers only
      // their tabs. Fire-and-forget: loaders stay fast.
      void tabManager.activate(tab.id).catch(() => {});
      options.onMaterialized?.(tabs);
      await adapter.setupTab(dock);
      tabManager.lifecycle.set(key, TabLifecycleState.Opened, { tabId: tab.id });
      return { tab, tabs };
    } catch (error) {
      if (isRedirectResponse(error)) {
        throw error;
      }
      tabManager.lifecycle.set(key, TabLifecycleState.OpenFailed, { tabId: tab?.id ?? null, error });
      return { tab, tabs, error };
    }
  })();

  setupInFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    setupInFlight.delete(key);
  }
}

export async function cleanupTab(
  dock: DockPointer,
  tab: Tab,
  options: { markClosing?: boolean } = {},
): Promise<void> {
  const key = tabKey(tab);
  if (options.markClosing !== false) {
    tabManager.lifecycle.set(key, TabLifecycleState.Closing, { tabId: tab.id });
  }
  try {
    await (adapters.get(dock.viewType ?? '') ?? defaultAdapter).cleanupTab(dock, tab);
  } catch (error) {
    tabManager.lifecycle.set(key, TabLifecycleState.CloseFailed, { tabId: tab.id, error });
    throw error;
  }
}

/**
 * Close a tab through its lifecycle: `Closing` is set synchronously (the strip
 * filters it out on the same tick), then adapter cleanup + backend close run.
 * Failure is fully conveyed through the `CloseFailed` lifecycle entry — the
 * promise never rejects (callers need no catch), resolving `[]` on failure.
 */
export async function closeTabWithLifecycle(tab: Tab): Promise<Tab[]> {
  const dockData = tab.dockPointer;
  const dock = dockData ? new DockPointer(dockData) : null;
  const key = tabKey(tab);
  try {
    if (dock) {
      await cleanupTab(dock, tab);
    } else {
      tabManager.lifecycle.set(key, TabLifecycleState.Closing, { tabId: tab.id });
    }
    return await tabManager.close(tab.id);
  } catch (error) {
    tabManager.lifecycle.set(key, TabLifecycleState.CloseFailed, { tabId: tab.id, error });
    return [];
  }
}

/**
 * Batch close waits for the one durable backend acknowledgement before hiding
 * the chips. This deliberately differs from the optimistic single-close path:
 * close-all completion is commonly followed immediately by reload/navigation,
 * which used to abort the fan-out requests and resurrect every tab.
 */
export async function closeTabsWithLifecycle(
  tabs: Tab[],
  projectId: string | null = null,
): Promise<Tab[]> {
  const unique = [...new Map(tabs.map((tab) => [tab.id, tab])).values()];
  const ready = (
    await Promise.all(
      unique.map(async (tab) => {
        const dockData = tab.dockPointer;
        const dock = dockData ? new DockPointer(dockData) : null;
        try {
          if (dock) await cleanupTab(dock, tab, { markClosing: false });
          return tab;
        } catch {
          return null;
        }
      }),
    )
  ).filter((tab): tab is Tab => tab !== null);

  if (ready.length === 0) return [];
  try {
    const result = await tabManager.closeMany(ready.map((tab) => tab.id), projectId);
    for (const tab of ready) {
      tabManager.lifecycle.set(tabKey(tab), TabLifecycleState.Closing, { tabId: tab.id });
    }
    return result;
  } catch (error) {
    for (const tab of ready) {
      tabManager.lifecycle.set(tabKey(tab), TabLifecycleState.CloseFailed, { tabId: tab.id, error });
    }
    return [];
  }
}

/** Materialize a dock and immediately adopt its returned global projection. */
export async function setupTabAndAdopt(
  dock: DockPointer,
  options?: SetupTabOptions,
): Promise<void> {
  const onMaterialized = options?.onMaterialized;
  let adoptedMaterializedTabs = false;
  const result = await setupTab(dock, {
    ...options,
    onMaterialized: (tabs) => {
      adoptedMaterializedTabs = true;
      onMaterialized?.(tabs);
      tabManager.adoptGlobal(tabs);
    },
  });
  if (!adoptedMaterializedTabs && result.tabs && result.tabs.length > 0) {
    tabManager.adoptGlobal(result.tabs);
  }
}

export function resetTabContentLifecycleForTests(): void {
  setupInFlight.clear();
  adapters.clear();
  tabManager.lifecycle.resetForTests();
}
