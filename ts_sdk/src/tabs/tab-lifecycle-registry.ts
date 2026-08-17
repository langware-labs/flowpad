import { Tab } from '../entities/tab';
import { tabKey } from './tab-selectors';

export enum TabLifecycleState {
  Opening = 'opening',
  Opened = 'opened',
  OpenFailed = 'open_failed',
  Closing = 'closing',
  CloseFailed = 'close_failed',
}

export interface TabLifecycleEntry {
  key: string;
  tabId: string | null;
  state: TabLifecycleState;
  error: string | null;
  updatedAt: number;
}

export interface SetTabLifecycleOptions {
  tabId?: string | null;
  error?: unknown;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Tab content failed to load.';
}

/** Headless, per-client lifecycle state. It performs no tab actions or content setup. */
export class TabLifecycleRegistry {
  private readonly entries = new Map<string, TabLifecycleEntry>();
  private readonly listeners = new Set<() => void>();
  private snapshot: ReadonlyMap<string, TabLifecycleEntry> = new Map();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): ReadonlyMap<string, TabLifecycleEntry> => {
    return this.snapshot;
  };

  get(key: string | null | undefined): TabLifecycleEntry | null {
    return key ? (this.entries.get(key) ?? null) : null;
  }

  getForTab(tab: Tab): TabLifecycleEntry | null {
    return this.get(tabKey(tab));
  }

  set(
    key: string,
    state: TabLifecycleState,
    options: SetTabLifecycleOptions = {},
  ): TabLifecycleEntry {
    const previous = this.entries.get(key);
    const entry: TabLifecycleEntry = {
      key,
      tabId: options.tabId !== undefined ? options.tabId : (previous?.tabId ?? null),
      state,
      error: options.error === undefined || options.error === null ? null : errorMessage(options.error),
      updatedAt: Date.now(),
    };
    this.entries.set(key, entry);
    this.notify();
    return entry;
  }

  excludeClosing(tabs: readonly Tab[]): Tab[] {
    const open = tabs.filter(
      (tab) => this.snapshot.get(tabKey(tab))?.state !== TabLifecycleState.Closing,
    );
    // Preserve the caller's array identity when no row is closing so derived
    // React memos do not rerun for unrelated lifecycle traffic.
    return open.length === tabs.length ? (tabs as Tab[]) : open;
  }

  reconcile(tabs: readonly Tab[]): void {
    const visibleIds = new Set(tabs.map((tab) => tab.id));
    const visibleKeys = new Set(tabs.map((tab) => tabKey(tab)));
    let changed = false;
    for (const [key, entry] of this.entries) {
      if (entry.tabId ? !visibleIds.has(entry.tabId) : !visibleKeys.has(key)) {
        this.entries.delete(key);
        changed = true;
      }
    }
    if (changed) this.notify();
  }

  resetForTests(): void {
    this.entries.clear();
    this.notify();
  }

  private notify(): void {
    this.snapshot = new Map(this.entries);
    for (const listener of this.listeners) listener();
  }
}
