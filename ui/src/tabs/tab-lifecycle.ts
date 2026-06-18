import { Tab } from '@sdk';
import { useSyncExternalStore } from 'react';
import { DockPointer } from '@src/navigation/DockPointer';

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
}

const entries = new Map<string, TabLifecycleEntry>();
const listeners = new Set<() => void>();
const setupInFlight = new Map<string, Promise<TabSetupResult>>();
let snapshot: ReadonlyMap<string, TabLifecycleEntry> = new Map();

const defaultAdapter: TabContentAdapter = {
  async setupTab() {
    return { tab: null };
  },
  async cleanupTab() {},
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
  return !(dock.viewType === 'shell' && dock.pointer === 'new_terminal');
}

async function materializeTab(dock: DockPointer): Promise<{ tab: Tab | null; tabs: Tab[] }> {
  const scoped = await Tab.getFromDockPointer(dock);
  const tab = findTabForDock(scoped, dock);
  if (tab) return { tab, tabs: scoped };
  const all = await Tab.listAll();
  return { tab: findTabForDock(all, dock), tabs: all };
}

function adapterFor(dock: DockPointer, options: SetupTabOptions): TabContentAdapter {
  if (options.setupContent) {
    return {
      async setupTab() {
        await options.setupContent?.();
        return { tab: null };
      },
      cleanupTab: options.adapter?.cleanupTab ?? defaultAdapter.cleanupTab,
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

export async function closeTabWithLifecycle(tab: Tab): Promise<Tab[]> {
  const dockData = tab.dockPointer;
  const dock = dockData ? new DockPointer(dockData) : null;
  const key = tabKey(tab);
  if (dock) {
    await cleanupTab(dock, tab);
  } else {
    setEntry(key, TabLifecycleState.Closing, { tabId: tab.id });
  }
  try {
    return await Tab.closeById(tab.id);
  } catch (error) {
    setEntry(key, TabLifecycleState.CloseFailed, { tabId: tab.id, error });
    throw error;
  }
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
