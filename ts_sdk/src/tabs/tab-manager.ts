import type { IEntity } from '../IEntity';
import type { IDockPointer } from '../models/DockPointer';
import { TypeId } from '../models/TypeId';
import { EntityTypes } from '../schema/types';
import { Tab, type INewTabOpts, type ITab } from '../entities/tab';
import { ConnectionManager, type BroadcastMessage, type DataOpType } from '../websocket';
import { TabLifecycleRegistry } from './tab-lifecycle-registry';
import { computeReorder } from './tab-order';
import { resolveNextTabPure } from './tab-selection';
import {
  tabForDockKey,
  tabForTargetId,
  tabsForProject,
  terminalTabsForScope,
  type TabScope,
} from './tab-selectors';

type TabConnection = Pick<ConnectionManager, 'on' | 'off'>;

/** The low-level wire operations used by TabManager. The production gateway is
 * `Tab`; the seam exists so a manager can be tested without replacing global
 * SDK state. */
export interface TabGateway {
  listAll(): Promise<Tab[]>;
  newTab(pointer: string, options?: INewTabOpts): Promise<Tab[]>;
  getFromDockPointer(
    dock: IDockPointer,
    options?: { parentTabId?: string | null; afterTabId?: string | null },
  ): Promise<Tab[]>;
  resolveDockTarget(dock: IDockPointer): ReturnType<typeof Tab.resolveDockTarget>;
  activateById(tabId: string): Promise<void>;
  closeById(tabId: string): Promise<Tab[]>;
  closeManyByIds(tabIds: string[], projectId?: string | null): Promise<Tab[]>;
  renameById(tabId: string, name: string): Promise<Tab[]>;
  setNameById(tabId: string, name: string): Promise<Tab[]>;
  reorder(
    tabId: string,
    afterId: string | null,
    beforeId: string | null,
    projectId?: string | null,
  ): Promise<Tab[]>;
}

export interface TabManagerOptions {
  gateway?: TabGateway;
  connection?: TabConnection | (() => TabConnection);
}

const defaultConnection = (): TabConnection => ConnectionManager.getInstance();

function coerceTab(tab: Tab | ITab): Tab {
  if (tab instanceof Tab) return tab;
  try {
    return new Tab(tab);
  } catch {
    // Constructing a second entity with an already-cached id can throw. Keep
    // the old store's data-only fallback so adopting a wire list stays total.
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

/**
 * Headless owner of the canonical, unscoped tab projection and tab-domain
 * operations. It deliberately owns no selected-tab state and performs no
 * navigation: selection remains URL-first in the application.
 */
export class TabManager {
  readonly lifecycle = new TabLifecycleRegistry();

  private readonly gateway: TabGateway;
  private readonly getConnection: () => TabConnection;
  private snapshot: Tab[] = [];
  private readonly listeners = new Set<() => void>();
  private refreshInFlight: Promise<Tab[]> | null = null;
  private refreshRequestedAgain = false;
  private attached = false;
  private loadedOnce = false;
  private broadcastHandler: ((message: BroadcastMessage) => void) | null = null;
  private attachedConnection: TabConnection | null = null;
  private pendingIntentKey: string | null = null;

  constructor(options: TabManagerOptions = {}) {
    this.gateway = options.gateway ?? Tab;
    const connection = options.connection;
    this.getConnection =
      typeof connection === 'function'
        ? connection
        : connection
          ? () => connection
          : defaultConnection;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): readonly Tab[] => this.snapshot;

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private refreshInBackground(): void {
    // Explicit refresh callers receive failures. Event/startup refreshes own
    // them so a disconnected backend cannot create an unhandled rejection.
    void this.refresh().catch(() => undefined);
  }

  attachTabsChangedPing(): void {
    if (this.attached) return;
    const connection = this.getConnection();
    const handler = (message: BroadcastMessage): void => {
      if (message?.broadcast_type === 'tabs_changed') this.refreshInBackground();
    };
    connection.on('on_broadcast', handler);
    this.attached = true;
    this.attachedConnection = connection;
    this.broadcastHandler = handler;
  }

  ensureInitialLoad(): void {
    if (this.loadedOnce) return;
    this.loadedOnce = true;
    this.refreshInBackground();
  }

  start(): void {
    this.attachTabsChangedPing();
    this.ensureInitialLoad();
  }

  refresh(): Promise<Tab[]> {
    if (this.refreshInFlight) {
      this.refreshRequestedAgain = true;
      return this.refreshInFlight;
    }

    this.refreshInFlight = (async () => {
      try {
        let tabs = await this.gateway.listAll();
        this.adoptGlobal(tabs);
        while (this.refreshRequestedAgain) {
          this.refreshRequestedAgain = false;
          tabs = await this.gateway.listAll();
          this.adoptGlobal(tabs);
        }
        return tabs;
      } finally {
        this.refreshInFlight = null;
        this.refreshRequestedAgain = false;
      }
    })();
    return this.refreshInFlight;
  }

  /** Replace the canonical store with an unscoped `list_all` projection. */
  adoptGlobal(tabs: readonly (Tab | ITab)[]): void {
    this.snapshot = tabs.map(coerceTab);
    // Lifecycle observers must settle before tab observers render this list.
    this.lifecycle.reconcile(this.snapshot);
    this.notify();
  }

  previewReorder(reorderId: string, afterId: string | null, beforeId: string | null): void {
    const byId = new Map(this.snapshot.map((tab) => [tab.id, tab]));
    const order = computeReorder(
      this.snapshot.map((tab) => tab.id),
      reorderId,
      afterId,
      beforeId,
    );
    this.snapshot = order.map((id) => byId.get(id)).filter((tab): tab is Tab => tab != null);
    this.notify();
  }



  forProject(projectId: string | null): Tab[] {
    return tabsForProject(this.snapshot, projectId);
  }




  findByDockKey(key: string | null | undefined): Tab | null {
    return tabForDockKey(this.snapshot, key);
  }





  setPendingIntent(key: string | null): void {
    this.pendingIntentKey = key;
  }

  peekPendingIntent(): string | null {
    return this.pendingIntentKey;
  }

  consumePendingIntent(): void {
    this.pendingIntentKey = null;
  }

  resolveNext(
    tabs: readonly Tab[],
    excludeIds?: ReadonlySet<string>,
    preferProjectId?: string | null,
  ): Tab | null {
    const result = resolveNextTabPure({
      tabs,
      excludeIds,
      preferProjectId,
      pendingIntentKey: this.pendingIntentKey,
    });
    if (result.consumedPendingIntent) this.consumePendingIntent();
    return result.tab;
  }

  listAll(): Promise<Tab[]> {
    return this.gateway.listAll();
  }

  newTab(pointer: string, options?: INewTabOpts): Promise<Tab[]> {
    return this.gateway.newTab(pointer, options);
  }

  ensureDock(
    dock: IDockPointer,
    options?: { parentTabId?: string | null; afterTabId?: string | null },
  ): Promise<Tab[]> {
    return this.gateway.getFromDockPointer(dock, options);
  }

  resolveDockTarget(dock: IDockPointer): ReturnType<typeof Tab.resolveDockTarget> {
    return this.gateway.resolveDockTarget(dock);
  }

  activate(tabId: string): Promise<void> {
    return this.gateway.activateById(tabId);
  }

  close(tabId: string): Promise<Tab[]> {
    return this.gateway.closeById(tabId);
  }

  closeMany(tabIds: string[], projectId?: string | null): Promise<Tab[]> {
    return this.gateway.closeManyByIds(tabIds, projectId);
  }

  rename(tabId: string, name: string): Promise<Tab[]> {
    return this.gateway.renameById(tabId, name);
  }

  setName(tabId: string, name: string): Promise<Tab[]> {
    return this.gateway.setNameById(tabId, name);
  }

  reorder(
    tabId: string,
    afterId: string | null,
    beforeId: string | null,
    projectId?: string | null,
  ): Promise<Tab[]> {
    return this.gateway.reorder(tabId, afterId, beforeId, projectId);
  }

  async getTerminalTabsSnapshot(scope: TabScope = 'all', projectId: string | null = null): Promise<Tab[]> {
    const tabs = await this.refresh();
    return terminalTabsForScope(tabs, scope, projectId);
  }

  async closeTarget(target: TypeId | string): Promise<void> {
    const tab = await this.resolveTargetFromStore(target);
    if (tab) await this.close(tab.id);
  }

  async renameTarget(target: TypeId | string, name: string): Promise<void> {
    const tab = await this.resolveTargetFromStore(target);
    if (tab) await this.rename(tab.id, name);
  }

  async syncTargetName(target: TypeId | string, name: string): Promise<void> {
    const tab = await this.resolveTargetFromStore(target);
    if (tab && tab.name !== name) await this.setName(tab.id, name);
  }

  async syncDockName(tabHash: string | null | undefined, name: string | null | undefined): Promise<void> {
    const trimmed = name?.trim();
    if (!tabHash || !trimmed) return;
    const tab = this.findByDockKey(tabHash);
    if (!tab || tab.name === trimmed) return;
    await this.setName(tab.id, trimmed);
    await this.refresh();
  }

  attachContentEntitySync(): () => void {
    const connection = this.getConnection();
    const handler = (_typeIdString: string, op: DataOpType, data: IEntity): void => {
      if (op === 'delete') return;
      const type = (data as { type?: string | null } | null)?.type;
      if (type === EntityTypes.Shell || type === EntityTypes.AgenticProcess) return;
      const id = data?.id;
      const name = (data as { name?: string | null } | null)?.name;
      const remote = (data as { remote?: unknown } | null)?.remote;
      if (!type || !id) return;
      const tab = this.snapshot.find(
        (candidate) => candidate.target_type === type && candidate.target_id === id,
      );
      if (!tab) return;
      const nameChanged = typeof name === 'string' && name.length > 0 && tab.name !== name;
      const remoteChanged = typeof remote === 'boolean' && tab.target_remote !== remote;
      if (!nameChanged && !remoteChanged) return;
      void (async () => {
        if (nameChanged) await this.setName(tab.id, name);
        await this.refresh();
      })().catch(() => undefined);
    };
    connection.on('on_data_op', handler);
    return () => connection.off('on_data_op', handler);
  }

  stampTargetRecency(targetType: string, targetId: string): void {
    const matches = (tab: Tab): boolean => tab.target_type === targetType && tab.target_id === targetId;
    const cachedId = this.snapshot.find(matches)?.id;
    const resolvedId =
      cachedId !== undefined
        ? Promise.resolve(cachedId)
        : this.refresh().then((tabs) => tabs.find(matches)?.id);
    void resolvedId
      .then((id) => (id ? this.activate(id) : undefined))
      .catch(() => undefined);
  }

  resetForTests(): void {
    if (this.attachedConnection && this.broadcastHandler) {
      this.attachedConnection.off('on_broadcast', this.broadcastHandler);
    }
    this.snapshot = [];
    this.listeners.clear();
    this.refreshInFlight = null;
    this.refreshRequestedAgain = false;
    this.attached = false;
    this.loadedOnce = false;
    this.broadcastHandler = null;
    this.attachedConnection = null;
    this.pendingIntentKey = null;
    this.lifecycle.resetForTests();
  }

  private parseTarget(target: TypeId | string): string | null {
    try {
      return new TypeId(typeof target === 'string' ? target : target.toString()).id;
    } catch {
      return null;
    }
  }

  private async resolveTargetFromStore(target: TypeId | string): Promise<Tab | null> {
    const targetId = this.parseTarget(target);
    if (!targetId) return null;
    let tabs = this.snapshot;
    if (tabs.length === 0) tabs = await this.refresh();
    return tabForTargetId(tabs, targetId);
  }
}

export const tabManager = new TabManager();
