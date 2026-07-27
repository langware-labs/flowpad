import { Tab } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import {
  closeTabWithLifecycle,
  excludeClosingTabs,
  getTabLifecycle,
  registerTabContentAdapter,
  resetTabLifecycleForTests,
  setTabLifecycleForTests,
  setupTab,
  syncTabLifecycleWithTabs,
  TabLifecycleState,
  type TabLifecycleEntry,
} from '@src/tabs/tab-lifecycle';
import { setActiveTabParent } from '@src/tabs/tab-parent-context';
import { ViewType } from '@src/types/ViewType';
import { afterEach, describe, expect, it, vi } from 'vitest';

function dock(id = '5e11aaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'): DockPointer {
  return new DockPointer(ViewType.SHELL, `shell-${id}`);
}

let tabIdCounter = 0;
function nextTabId(): string {
  tabIdCounter += 1;
  return `00000000-0000-4000-8000-${String(tabIdCounter).padStart(12, '0')}`;
}

function tabFor(d: DockPointer, id = nextTabId()): Tab {
  return new Tab({
    id,
    pointer: d.toJSON() ?? '',
    target_type: 'shell',
    target_id: d.pointer?.replace(/^shell-/, '') ?? null,
    project_id: null,
    name: 'Terminal',
    visible: true,
  });
}

function mockNoExistingTabs() {
  return vi.spyOn(Tab, 'listAll').mockResolvedValue([]);
}

afterEach(() => {
  vi.restoreAllMocks();
  resetTabLifecycleForTests();
});

describe('tab lifecycle registry', () => {
  it('moves successful setup from opening to opened', async () => {
    const d = dock();
    const tab = tabFor(d);
    mockNoExistingTabs();
    vi.spyOn(Tab, 'getFromDockPointer').mockResolvedValue([tab]);

    await setupTab(d);

    expect(getTabLifecycle(d.tabHash)?.state).toBe(TabLifecycleState.Opened);
    expect(getTabLifecycle(d.tabHash)?.tabId).toBe(tab.id);
  });

  it('keeps a materialized tab visible when setup fails', async () => {
    const d = dock();
    const tab = tabFor(d);
    mockNoExistingTabs();
    vi.spyOn(Tab, 'getFromDockPointer').mockResolvedValue([tab]);
    registerTabContentAdapter(ViewType.SHELL, {
      setupTab() {
        return Promise.reject(new Error('attach failed'));
      },
      cleanupTab: () => Promise.resolve(),
    });

    const result = await setupTab(d);

    expect(result.tab?.id).toBe(tab.id);
    expect(getTabLifecycle(d.tabHash)?.state).toBe(TabLifecycleState.OpenFailed);
    expect(getTabLifecycle(d.tabHash)?.error).toBe('attach failed');
  });

  it('emits materialized tabs before content setup resolves', async () => {
    const d = dock();
    const tab = tabFor(d);
    // materializeTab calls Tab.listAll() twice: first as the existence check
    // (must be empty so the tab is created), then re-reads the UNSCOPED global
    // list for adoption AFTER getFromDockPointer persists the new tab. In
    // production that re-read includes the new tab; simulate it so onMaterialized
    // carries the materialized global list (not an empty one).
    vi.spyOn(Tab, 'listAll').mockResolvedValueOnce([]).mockResolvedValue([tab]);
    vi.spyOn(Tab, 'getFromDockPointer').mockResolvedValue([tab]);

    let markSetupStarted: () => void = () => {};
    let releaseSetup: () => void = () => {};
    const setupStarted = new Promise<void>((resolve) => {
      markSetupStarted = resolve;
    });
    const setupGate = new Promise<void>((resolve) => {
      releaseSetup = resolve;
    });
    const setupContent = vi.fn(async () => {
      markSetupStarted();
      await setupGate;
    });
    const materializedTabs: Tab[][] = [];

    const resultPromise = setupTab(d, {
      setupContent,
      onMaterialized: (tabs) => materializedTabs.push(tabs),
    });

    await setupStarted;

    expect(materializedTabs).toHaveLength(1);
    expect(materializedTabs[0].map((materialized) => materialized.id)).toEqual([tab.id]);
    expect(getTabLifecycle(d.tabHash)?.state).toBe(TabLifecycleState.Opening);
    expect(getTabLifecycle(d.tabHash)?.tabId).toBe(tab.id);

    releaseSetup();
    const result = await resultPromise;

    expect(result.tab?.id).toBe(tab.id);
    expect(getTabLifecycle(d.tabHash)?.state).toBe(TabLifecycleState.Opened);
  });

  it('reuses a visible normalized legacy row before creating a canonical duplicate', async () => {
    const shellId = '8fc3bec4-0f33-4333-8b2b-c95a8f0ae194';
    const d = dock(shellId);
    const legacy = new Tab({
      id: '11111111-1111-4111-8111-111111111111',
      pointer: `dock/shell-${shellId}`,
      target_type: 'shell',
      target_id: shellId,
      project_id: null,
      name: 'pinned shell',
      visible: true,
    });
    vi.spyOn(Tab, 'listAll').mockResolvedValue([legacy]);
    const materialize = vi.spyOn(Tab, 'getFromDockPointer').mockResolvedValue([tabFor(d)]);

    const result = await setupTab(d);

    expect(result.tab?.id).toBe(legacy.id);
    expect(materialize).not.toHaveBeenCalled();
    expect(getTabLifecycle(d.tabHash)?.state).toBe(TabLifecycleState.Opened);
  });

  it('moves cleanup success from closing to removed after the tab list drops it', async () => {
    const d = dock();
    const tab = tabFor(d);
    vi.spyOn(Tab, 'closeById').mockResolvedValue([]);

    await closeTabWithLifecycle(tab);
    expect(getTabLifecycle(d.tabHash)?.state).toBe(TabLifecycleState.Closing);

    syncTabLifecycleWithTabs([]);
    expect(getTabLifecycle(d.tabHash)).toBeNull();
  });

  it('moves cleanup failure from closing to close_failed', async () => {
    const d = dock();
    const tab = tabFor(d);
    registerTabContentAdapter(ViewType.SHELL, {
      setupTab() {
        return Promise.resolve({ tab: null });
      },
      cleanupTab() {
        return Promise.reject(new Error('cleanup failed'));
      },
    });

    // The CloseFailed lifecycle entry IS the failure channel — the promise
    // resolves (empty) so no caller needs a catch.
    await expect(closeTabWithLifecycle(tab)).resolves.toEqual([]);

    expect(getTabLifecycle(d.tabHash)?.state).toBe(TabLifecycleState.CloseFailed);
    expect(getTabLifecycle(d.tabHash)?.error).toBe('cleanup failed');
  });

  it('moves close action failure from closing to close_failed', async () => {
    const d = dock();
    const tab = tabFor(d);
    vi.spyOn(Tab, 'closeById').mockRejectedValue(new Error('close failed'));

    await expect(closeTabWithLifecycle(tab)).resolves.toEqual([]);

    expect(getTabLifecycle(d.tabHash)?.state).toBe(TabLifecycleState.CloseFailed);
    expect(getTabLifecycle(d.tabHash)?.error).toBe('close failed');
  });

  it('clears lifecycle entries when tabs_changed removes the tab', async () => {
    const d = dock();
    const tab = tabFor(d);
    mockNoExistingTabs();
    vi.spyOn(Tab, 'getFromDockPointer').mockResolvedValue([tab]);
    await setupTab(d);

    syncTabLifecycleWithTabs([]);

    expect(getTabLifecycle(d.tabHash)).toBeNull();
  });

  it('clears key-only lifecycle entries when the tab list does not contain the dock', () => {
    const d = dock();
    setTabLifecycleForTests(d.tabHash, TabLifecycleState.OpenFailed, { error: 'materialize failed' });

    syncTabLifecycleWithTabs([]);

    expect(getTabLifecycle(d.tabHash)).toBeNull();
  });

  it('does not materialize /dock/shell/new_terminal as a persistent tab', async () => {
    const d = new DockPointer(ViewType.SHELL, 'new_terminal');
    const materialize = vi.spyOn(Tab, 'getFromDockPointer').mockResolvedValue([]);
    const setupContent = vi.fn().mockResolvedValue(undefined);

    await setupTab(d, { setupContent });

    expect(materialize).not.toHaveBeenCalled();
    expect(setupContent).toHaveBeenCalledTimes(1);
    expect(getTabLifecycle(d.tabHash)).toBeNull();
  });
});

describe('excludeClosingTabs', () => {
  function entry(key: string, state: TabLifecycleState): [string, TabLifecycleEntry] {
    return [key, { key, tabId: null, state, error: null, updatedAt: 0 }];
  }

  it('filters only Closing tabs; Opened/CloseFailed/absent stay', () => {
    const dClosing = dock('5e11aaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01');
    const dOpened = dock('5e11aaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02');
    const dFailed = dock('5e11aaaa-aaaa-4aaa-8aaa-aaaaaaaaaa03');
    const dAbsent = dock('5e11aaaa-aaaa-4aaa-8aaa-aaaaaaaaaa04');
    const tabs = [tabFor(dClosing), tabFor(dOpened), tabFor(dFailed), tabFor(dAbsent)];
    const lifecycles = new Map([
      entry(dClosing.tabHash, TabLifecycleState.Closing),
      entry(dOpened.tabHash, TabLifecycleState.Opened),
      entry(dFailed.tabHash, TabLifecycleState.CloseFailed),
    ]);

    expect(excludeClosingTabs(tabs, lifecycles)).toEqual(tabs.slice(1));
  });

  it('falls back to tab.id as the key when there is no dock pointer', () => {
    const tab = new Tab({ id: nextTabId(), pointer: '', name: 'Bare', visible: true });
    const lifecycles = new Map([entry(tab.id, TabLifecycleState.Closing)]);

    expect(excludeClosingTabs([tab], lifecycles)).toEqual([]);
  });
});

describe('workspace child adoption guard', () => {
  // The vibe workspace registers its PROCESS tab in the global parent slot; the
  // chokepoint may adopt ONLY content-asset docks. A process/project dock
  // materialized while the slot is set is a navigation AWAY from the workspace
  // (its loader runs before the workspace unmounts) — adopting it produced the
  // nested-workspace / process-under-process corruption.
  const PARENT = '00000000-0000-4000-8000-00000000feed';
  const MD = '30c05e11-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  function assetDock(): DockPointer {
    return new DockPointer(ViewType.ASSETS, `editor/markdown/typeid/markdown-${MD}`);
  }
  function processDock(): DockPointer {
    return new DockPointer(ViewType.SHELL, `agentic_process-${MD}`);
  }
  function projectDock(): DockPointer {
    return new DockPointer(ViewType.PROJECT, MD);
  }

  afterEach(() => setActiveTabParent(null));

  async function materializedParent(d: DockPointer): Promise<string | null | undefined> {
    setActiveTabParent(PARENT);
    mockNoExistingTabs();
    const spy = vi
      .spyOn(Tab, 'getFromDockPointer')
      .mockResolvedValue([new Tab({ id: nextTabId(), pointer: d.toJSON() ?? '', visible: true })]);
    await setupTab(d);
    expect(spy).toHaveBeenCalledTimes(1);
    return (spy.mock.calls[0][1] as { parentTabId?: string | null } | undefined)?.parentTabId;
  }

  it('adopts a content-asset dock into the registered workspace', async () => {
    expect(await materializedParent(assetDock())).toBe(PARENT);
  });

  it('never adopts a process dock', async () => {
    expect(await materializedParent(processDock())).toBeNull();
  });

  it('never adopts a project dock', async () => {
    expect(await materializedParent(projectDock())).toBeNull();
  });

  it('does not re-parent an EXISTING process tab on navigation (reuse fast-path)', async () => {
    setActiveTabParent(PARENT);
    const d = processDock();
    const existing = new Tab({
      id: nextTabId(),
      pointer: d.toJSON() ?? '',
      target_type: 'agentic_process',
      target_id: MD,
      project_id: 'p1',
      visible: true,
      parent_tab_id: null,
    });
    vi.spyOn(Tab, 'listAll').mockResolvedValue([existing]);
    const spy = vi.spyOn(Tab, 'getFromDockPointer');
    await setupTab(d);
    expect(spy).not.toHaveBeenCalled();
  });

  it('falls through to the mint for a NON-adoptable tab carrying a stale workspace edge', async () => {
    // No workspace mounted. An assets-LIST row persisted with a parent (a stale
    // edge from the retired display-tab model — target_type null, so the
    // backend's target-type belt missed it) must NOT take the verbatim-reuse
    // fast path: it falls through to `getFromDockPointer`, whose backend
    // (`ensure_tab`'s adoptable-pointer guard) null-heals the edge — else the
    // vibe workspace resurrects the old process around the top-level assets
    // page (RCA 2026-07-16).
    const d = new DockPointer(ViewType.ASSETS, 'project-home');
    const stale = new Tab({
      id: nextTabId(),
      pointer: d.toJSON() ?? '',
      project_id: 'p1',
      visible: true,
      parent_tab_id: PARENT,
    });
    vi.spyOn(Tab, 'listAll').mockResolvedValue([stale]);
    const mint = vi
      .spyOn(Tab, 'getFromDockPointer')
      .mockResolvedValue([new Tab({ ...stale, parent_tab_id: null })]);
    await setupTab(d);
    expect(mint).toHaveBeenCalledTimes(1);
    expect((mint.mock.calls[0][1] as { parentTabId?: string | null } | undefined)?.parentTabId).toBeNull();
  });

  it('still re-parents an existing asset tab into the active workspace', async () => {
    setActiveTabParent(PARENT);
    const d = assetDock();
    const existing = new Tab({
      id: nextTabId(),
      pointer: d.toJSON() ?? '',
      target_type: 'markdown',
      target_id: MD,
      project_id: 'p1',
      visible: true,
      parent_tab_id: null,
    });
    vi.spyOn(Tab, 'listAll').mockResolvedValue([existing]);
    const spy = vi.spyOn(Tab, 'getFromDockPointer').mockResolvedValue([existing]);
    await setupTab(d);
    expect(spy).toHaveBeenCalledTimes(1);
    expect((spy.mock.calls[0][1] as { parentTabId?: string | null } | undefined)?.parentTabId).toBe(PARENT);
  });
});
