import { Tab, toplog } from '@sdk';
import { useSyncExternalStore } from 'react';
import { DockPointer } from '@src/navigation/DockPointer';
import { editorForType } from '@src/navigation/asset-doc-types';
import { ViewType } from '@src/types/ViewType';
import { getActiveTabParent } from './tab-parent-context';

export enum TabLifecycleState {
  Opening = 'opening',
  Opened = 'opened',
  OpenFailed = 'open_failed',
  Closing = 'closing',
  CloseFailed = 'close_failed',
}

export interface TabSetupResult {
  tab: Tab | null;
  tabs?: Tab[];
  error?: unknown;
}

export interface TabContentAdapter {
  setupTab(dock: DockPointer): Promise<TabSetupResult>;
  cleanupTab(dock: DockPointer, tab: Tab): Promise<void>;
}

export interface TabLifecycleEntry {
  key: string;
  tabId: string | null;
  state: TabLifecycleState;
  error: string | null;
  updatedAt: number;
}

interface SetupTabOptions {
  setupContent?: () => Promise<void>;
  adapter?: TabContentAdapter;
  onMaterialized?: (tabs: Tab[]) => void;
}

const entries = new Map<string, TabLifecycleEntry>();
const listeners = new Set<() => void>();
const setupInFlight = new Map<string, Promise<TabSetupResult>>();
let snapshot: ReadonlyMap<string, TabLifecycleEntry> = new Map();

const defaultAdapter: TabContentAdapter = {
  setupTab: () => Promise.resolve({ tab: null }),
  cleanupTab: () => Promise.resolve(),
};

const adapters = new Map<string, TabContentAdapter>();

function notify(): void {
  snapshot = new Map(entries);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): ReadonlyMap<string, TabLifecycleEntry> {
  return snapshot;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Tab content failed to load.';
}

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

function setEntry(
  key: string,
  state: TabLifecycleState,
  options: { tabId?: string | null; error?: unknown } = {},
): TabLifecycleEntry {
  const previous = entries.get(key);
  const entry: TabLifecycleEntry = {
    key,
    tabId: options.tabId !== undefined ? options.tabId : (previous?.tabId ?? null),
    state,
    error: options.error === undefined || options.error === null ? null : getErrorMessage(options.error),
    updatedAt: Date.now(),
  };
  entries.set(key, entry);
  notify();
  return entry;
}

function tabKey(tab: Tab): string {
  return tab.dockPointer?.tabHash ?? tab.id;
}

function findTabForDock(tabs: Tab[], dock: DockPointer): Tab | null {
  const key = dock.tabHash;
  if (!key) return null;
  return tabs.find((tab) => tabKey(tab) === key) ?? null;
}

function shouldMaterializeDock(dock: DockPointer): boolean {
  if (!dock.tabHash) return false;
  if (dock.viewType === ViewType.AGENTIC_PROCESS) return false;
  return !(dock.viewType === ViewType.SHELL && dock.pointer === 'new_terminal');
}

/**
 * Does this dock address a first-class CONTENT asset (markdown/skill/whiteboard/
 * …) — i.e. an entity whose `project_id` the tab must mirror? True for a vfs
 * asset dock and for a typeid dock whose type maps to an asset editor; false for
 * shells, agentic processes, bare projects, inbox/triggers (those resolve their
 * project differently — or legitimately have none — and must keep the fast
 * reuse path).
 */
function dockAddressesAsset(dock: DockPointer): boolean {
  if (dock.vfsPath) return true;
  const tid = dock.targetTypeId;
  return !!(tid && editorForType(tid.type));
}

async function materializeTab(dock: DockPointer): Promise<{ tab: Tab | null; tabs: Tab[] }> {
  const t0 = performance.now();
  const existing = await Tab.listAll();
  toplog.log(
    'process_load',
    `materializeTab Tab.listAll took ${(performance.now() - t0).toFixed(1)}ms (${existing.length} tabs) dock=${dock.tabHash}`,
  );
  const existingTab = findTabForDock(existing, dock);
  // A workspace surface (the vibe workspace) may have registered its process
  // tab as the parent for tabs materialized right now. Only a CONTENT-ASSET
  // dock is adoptable — a process/project/assets-list dock is a navigation
  // *away* from the workspace (its loader runs before the workspace unmounts
  // and clears the slot), and adopting those was how nested-workspace /
  // process-under-process corruption arose. This is the ONLY grouping seam;
  // no navigation call site knows about children, and the backend enforces the
  // same invariant (`_PARENT_FORBIDDEN_TARGET_TYPES`) as the second belt.
  const parentTabId = dockAddressesAsset(dock) ? getActiveTabParent() : null;
  // Mirror the backend's self-parent guard: a tab can never adopt itself, and
  // would otherwise re-resolve on every return navigation forever.
  const needsReparent =
    !!parentTabId &&
    !!existingTab &&
    existingTab.id !== parentTabId &&
    existingTab.parent_tab_id !== parentTabId;
  // Reuse an existing tab verbatim EXCEPT a project-less content tab (see the
  // project self-heal below) OR one that needs re-parenting into the active
  // workspace. Both cases fall through to `getFromDockPointer`, which re-derives
  // project_id from the asset and adopts the parent, self-healing the row.
  if (existingTab && (existingTab.project_id || !dockAddressesAsset(dock)) && !needsReparent) {
    return { tab: existingTab, tabs: existing };
  }

  toplog.log('process_load', `materializeTab cache-miss → new_tab round trip dock=${dock.tabHash}`);
  // Create-or-resolve the dock's tab. `getFromDockPointer` → `new_tab` returns
  // the PROJECT-SCOPED list ({that project} + projectless), which must NEVER be
  // adopted into the GLOBAL all-tabs store (the caller applies `tabs` via
  // `applyAllTabs`): doing so erases every other project's tabs, collapsing the
  // footer projects-chip to a single project. Use the scoped list only to find
  // the materialized tab, then re-read the UNSCOPED global list for adoption.
  const scoped = await Tab.getFromDockPointer(dock, { parentTabId });
  const scopedTab = findTabForDock(scoped, dock);

  const all = await Tab.listAll();
  const tab = findTabForDock(all, dock) ?? scopedTab;
  return { tab, tabs: all };
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

  const inFlight = setupInFlight.get(key);
  if (inFlight) return inFlight;

  const promise = (async (): Promise<TabSetupResult> => {
    setEntry(key, TabLifecycleState.Opening);
    let tab: Tab | null = null;
    let tabs: Tab[] = [];
    try {
      const materialized = await materializeTab(dock);
      tab = materialized.tab;
      tabs = materialized.tabs;
      if (!tab) {
        throw new Error('Tab could not be materialized for this URL.');
      }
      setEntry(key, TabLifecycleState.Opening, { tabId: tab.id });
      options.onMaterialized?.(tabs);
      await adapter.setupTab(dock);
      setEntry(key, TabLifecycleState.Opened, { tabId: tab.id });
      return { tab, tabs };
    } catch (error) {
      if (isRedirectResponse(error)) {
        throw error;
      }
      setEntry(key, TabLifecycleState.OpenFailed, { tabId: tab?.id ?? null, error });
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

export async function cleanupTab(dock: DockPointer, tab: Tab): Promise<void> {
  const key = tabKey(tab);
  setEntry(key, TabLifecycleState.Closing, { tabId: tab.id });
  try {
    await (adapters.get(dock.viewType ?? '') ?? defaultAdapter).cleanupTab(dock, tab);
  } catch (error) {
    setEntry(key, TabLifecycleState.CloseFailed, { tabId: tab.id, error });
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
      setEntry(key, TabLifecycleState.Closing, { tabId: tab.id });
    }
    return await Tab.closeById(tab.id);
  } catch (error) {
    setEntry(key, TabLifecycleState.CloseFailed, { tabId: tab.id, error });
    return [];
  }
}

/**
 * Drop tabs whose lifecycle state is `Closing` — the strip's optimistic close:
 * the chip vanishes on the click tick while the backend close/teardown runs.
 * Only `Closing` is filtered, so a failed close (`CloseFailed`) resurfaces the
 * chip with its error state, and the entry is GC'd by `syncTabLifecycleWithTabs`
 * once the refreshed list drops the row for real.
 */
export function excludeClosingTabs(tabs: Tab[], lifecycles: ReadonlyMap<string, TabLifecycleEntry>): Tab[] {
  const open = tabs.filter((tab) => lifecycles.get(tabKey(tab))?.state !== TabLifecycleState.Closing);
  // Preserve input identity when nothing is closing (the common case) so
  // downstream memos short-circuit on lifecycle traffic unrelated to closes.
  return open.length === tabs.length ? tabs : open;
}

export function syncTabLifecycleWithTabs(tabs: Tab[]): void {
  const visibleIds = new Set(tabs.map((tab) => tab.id));
  const visibleKeys = new Set(tabs.map((tab) => tabKey(tab)));
  let changed = false;
  for (const [key, entry] of entries) {
    if (entry.tabId ? !visibleIds.has(entry.tabId) : !visibleKeys.has(key)) {
      entries.delete(key);
      changed = true;
    }
  }
  if (changed) notify();
}

export function getTabLifecycle(key: string | null | undefined): TabLifecycleEntry | null {
  return key ? (entries.get(key) ?? null) : null;
}

export function getTabLifecycleForTab(tab: Tab): TabLifecycleEntry | null {
  return getTabLifecycle(tabKey(tab));
}

export function useTabLifecycle(key: string | null | undefined): TabLifecycleEntry | null {
  const lifecycleSnapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return key ? (lifecycleSnapshot.get(key) ?? null) : null;
}

export function useTabLifecycles(): ReadonlyMap<string, TabLifecycleEntry> {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function resetTabLifecycleForTests(): void {
  entries.clear();
  setupInFlight.clear();
  adapters.clear();
  notify();
}

export function setTabLifecycleForTests(
  key: string,
  state: TabLifecycleState,
  options: { tabId?: string | null; error?: unknown } = {},
): void {
  setEntry(key, state, options);
}
