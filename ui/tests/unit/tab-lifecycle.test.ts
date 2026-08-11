import { Tab, tabManager, TabLifecycleState } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewMode } from '@src/contexts/view-mode-context';
import {
  closeTabWithLifecycle,
  closeTabsWithLifecycle,
  registerTabContentAdapter,
  resetTabContentLifecycleForTests,
  setupTab,
} from '@src/tabs/tab-content-lifecycle';
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
  resetTabContentLifecycleForTests();
});

describe('tab lifecycle registry', () => {
  it('moves successful setup from opening to opened', async () => {
    const d = dock();
    const tab = tabFor(d);
    mockNoExistingTabs();
    vi.spyOn(Tab, 'getFromDockPointer').mockResolvedValue([tab]);

    await setupTab(d);

    expect(tabManager.lifecycle.get(d.tabHash)?.state).toBe(TabLifecycleState.Opened);
    expect(tabManager.lifecycle.get(d.tabHash)?.tabId).toBe(tab.id);
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
    expect(tabManager.lifecycle.get(d.tabHash)?.state).toBe(TabLifecycleState.OpenFailed);
    expect(tabManager.lifecycle.get(d.tabHash)?.error).toBe('attach failed');
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
    expect(tabManager.lifecycle.get(d.tabHash)?.state).toBe(TabLifecycleState.Opening);
    expect(tabManager.lifecycle.get(d.tabHash)?.tabId).toBe(tab.id);

    releaseSetup();
    const result = await resultPromise;

    expect(result.tab?.id).toBe(tab.id);
    expect(tabManager.lifecycle.get(d.tabHash)?.state).toBe(TabLifecycleState.Opened);
  });

  it('reuses an opened content-asset tab while rerunning loader-owned context setup', async () => {
    const d = new DockPointer(
      ViewType.ASSETS,
      'editor/markdown/typeid/markdown-30c05e11-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );
    const tab = new Tab({
      id: nextTabId(),
      pointer: d.toJSON() ?? '',
      target_type: 'markdown',
      target_id: '30c05e11-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      project_id: '40c05e11-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      visible: true,
    });
    vi.spyOn(Tab, 'listAll').mockResolvedValueOnce([]).mockResolvedValue([tab]);
    vi.spyOn(Tab, 'getFromDockPointer').mockResolvedValue([tab]);
    vi.spyOn(Tab, 'activateById').mockResolvedValue([]);

    await setupTab(d);

    const list = vi.spyOn(Tab, 'listAll');
    const mint = vi.spyOn(Tab, 'getFromDockPointer');
    list.mockClear();
    mint.mockClear();
    const setupContent = vi.fn().mockResolvedValue(undefined);
    await setupTab(d.withViewMode(ViewMode.Vibe), { setupContent });

    expect(setupContent).toHaveBeenCalledTimes(1);
    expect(list).not.toHaveBeenCalled();
    expect(mint).not.toHaveBeenCalled();
    expect(tabManager.lifecycle.get(d.tabHash)?.state).toBe(TabLifecycleState.Opened);
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
    expect(tabManager.lifecycle.get(d.tabHash)?.state).toBe(TabLifecycleState.Opened);
  });

  it('moves cleanup success from closing to removed after the tab list drops it', async () => {
    const d = dock();
    const tab = tabFor(d);
    vi.spyOn(Tab, 'closeById').mockResolvedValue([]);

    await closeTabWithLifecycle(tab);
    expect(tabManager.lifecycle.get(d.tabHash)?.state).toBe(TabLifecycleState.Closing);

    tabManager.lifecycle.reconcile([]);
    expect(tabManager.lifecycle.get(d.tabHash)).toBeNull();
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

    expect(tabManager.lifecycle.get(d.tabHash)?.state).toBe(TabLifecycleState.CloseFailed);
    expect(tabManager.lifecycle.get(d.tabHash)?.error).toBe('cleanup failed');
  });

  it('moves close action failure from closing to close_failed', async () => {
    const d = dock();
    const tab = tabFor(d);
    vi.spyOn(Tab, 'closeById').mockRejectedValue(new Error('close failed'));

    await expect(closeTabWithLifecycle(tab)).resolves.toEqual([]);

    expect(tabManager.lifecycle.get(d.tabHash)?.state).toBe(TabLifecycleState.CloseFailed);
    expect(tabManager.lifecycle.get(d.tabHash)?.error).toBe('close failed');
  });

  it('batch close hides tabs only after the durable action acknowledges', async () => {
    const firstDock = dock('5e11aaaa-aaaa-4aaa-8aaa-aaaaaaaaaa11');
    const secondDock = dock('5e11aaaa-aaaa-4aaa-8aaa-aaaaaaaaaa12');
    const tabs = [tabFor(firstDock), tabFor(secondDock)];
    let acknowledge: (rows: Tab[]) => void = () => {};
    const closeResult = new Promise<Tab[]>((resolve) => {
      acknowledge = resolve;
    });
    let markBatchStarted: () => void = () => {};
    const batchStarted = new Promise<void>((resolve) => {
      markBatchStarted = resolve;
    });
    const closeMany = vi.spyOn(Tab, 'closeManyByIds').mockImplementation(() => {
      markBatchStarted();
      return closeResult;
    });

    const closing = closeTabsWithLifecycle(tabs, null);
    await batchStarted;

    expect(closeMany).toHaveBeenCalledWith(tabs.map((tab) => tab.id), null);
    expect(tabManager.lifecycle.get(firstDock.tabHash)).toBeNull();
    expect(tabManager.lifecycle.get(secondDock.tabHash)).toBeNull();

    acknowledge([]);
    await closing;
    expect(tabManager.lifecycle.get(firstDock.tabHash)?.state).toBe(TabLifecycleState.Closing);
    expect(tabManager.lifecycle.get(secondDock.tabHash)?.state).toBe(TabLifecycleState.Closing);
  });

  it('clears lifecycle entries when tabs_changed removes the tab', async () => {
    const d = dock();
    const tab = tabFor(d);
    mockNoExistingTabs();
    vi.spyOn(Tab, 'getFromDockPointer').mockResolvedValue([tab]);
    await setupTab(d);

    tabManager.lifecycle.reconcile([]);

    expect(tabManager.lifecycle.get(d.tabHash)).toBeNull();
  });

  it('does not materialize /dock/shell/new_terminal as a persistent tab', async () => {
    const d = new DockPointer(ViewType.SHELL, 'new_terminal');
    const materialize = vi.spyOn(Tab, 'getFromDockPointer').mockResolvedValue([]);
    const setupContent = vi.fn().mockResolvedValue(undefined);

    await setupTab(d, { setupContent });

    expect(materialize).not.toHaveBeenCalled();
    expect(setupContent).toHaveBeenCalledTimes(1);
    expect(tabManager.lifecycle.get(d.tabHash)).toBeNull();
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
  /** A plain terminal — same viewType as the process dock, different pointer. */
  function shellDock(): DockPointer {
    return new DockPointer(ViewType.SHELL, `shell-${MD}`);
  }
  function projectDock(): DockPointer {
    return new DockPointer(ViewType.PROJECT, MD);
  }
  function rawFileDock(): DockPointer {
    return DockPointer.forFile('/project/src/main.ts');
  }

  afterEach(() => tabManager.setActiveParentTabId(null));

  async function materializedParent(d: DockPointer): Promise<string | null | undefined> {
    tabManager.setActiveParentTabId(PARENT);
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

  it('adopts a PLAIN shell dock — a terminal opened inside the workspace', async () => {
    // Without this the terminal takes over the whole surface instead of
    // rendering in the workspace's display pane.
    expect(await materializedParent(shellDock())).toBe(PARENT);
  });

  it('never materializes (so never adopts) the new-terminal launcher landing', async () => {
    // It redirects into a real shell first; `shouldMaterializeDock` keeps it
    // away from the chokepoint entirely, so there is no tab to adopt.
    tabManager.setActiveParentTabId(PARENT);
    mockNoExistingTabs();
    const spy = vi.spyOn(Tab, 'getFromDockPointer');
    await setupTab(new DockPointer(ViewType.SHELL, 'new_terminal'));
    expect(spy).not.toHaveBeenCalled();
  });

  it('adopts a raw file editor dock into the registered workspace', async () => {
    expect(await materializedParent(rawFileDock())).toBe(PARENT);
  });

  it('never adopts a process dock', async () => {
    expect(await materializedParent(processDock())).toBeNull();
  });

  it('never adopts a project dock', async () => {
    expect(await materializedParent(projectDock())).toBeNull();
  });

  it('does not re-parent an EXISTING process tab on navigation (reuse fast-path)', async () => {
    tabManager.setActiveParentTabId(PARENT);
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

  it('keeps a shell child its parent edge when no workspace is mounted', async () => {
    // The inverse of the stale-edge stripper: a terminal adopted by a workspace
    // must stay a child when it is re-navigated to from outside one, or the
    // edge would be shed the first time the user clicks its chip. Verbatim
    // reuse — no re-mint — proves `staleParentEdge` stayed false.
    const d = shellDock();
    const existing = new Tab({
      id: nextTabId(),
      pointer: d.toJSON() ?? '',
      target_type: 'shell',
      target_id: MD,
      project_id: 'p1',
      visible: true,
      parent_tab_id: PARENT,
    });
    vi.spyOn(Tab, 'listAll').mockResolvedValue([existing]);
    const mint = vi.spyOn(Tab, 'getFromDockPointer');
    await setupTab(d);
    expect(mint).not.toHaveBeenCalled();
  });

  it('reuses a PROJECT-LESS global terminal verbatim', async () => {
    // The project self-heal is asset-scoped: a shell's project_id is pinned at
    // creation and null means "global", so chasing it would re-mint on every
    // navigation to a global terminal.
    const d = shellDock();
    const existing = new Tab({
      id: nextTabId(),
      pointer: d.toJSON() ?? '',
      target_type: 'shell',
      target_id: MD,
      project_id: null,
      visible: true,
      parent_tab_id: null,
    });
    vi.spyOn(Tab, 'listAll').mockResolvedValue([existing]);
    const mint = vi.spyOn(Tab, 'getFromDockPointer');
    await setupTab(d);
    expect(mint).not.toHaveBeenCalled();
  });

  it('still re-parents an existing asset tab into the active workspace', async () => {
    tabManager.setActiveParentTabId(PARENT);
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
    const spy = vi.spyOn(Tab, 'newTab').mockResolvedValue([
      new Tab({ ...existing, parent_tab_id: PARENT }),
    ]);
    await setupTab(d);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(
      (spy.mock.calls[0][1] as { parentTabId?: string | null } | undefined)
        ?.parentTabId,
    ).toBe(PARENT);
  });
});

describe('the URL names the workspace host', () => {
  const PROJ = 'dd682350-c185-52c9-a92b-d0667141b069';
  const ASSET = 'a684848a-af63-4c8a-988e-37a2c01b20b5';
  const PROC = 'abc1e873-1ae2-4c55-9242-6b4ddea51420';

  /** The process tab a hosted document should be adopted under. */
  function processTabRow(): Tab {
    return new Tab({
      id: nextTabId(),
      pointer: DockPointer.forShell(`agentic_process-${PROC}`).toJSON() ?? '',
      target_type: 'agentic_process',
      target_id: PROC,
      project_id: PROJ,
      visible: true,
    });
  }

  it('adopts the document under the host in the URL, with no ambient slot', async () => {
    const host = processTabRow();
    tabManager.adoptGlobal([host]);
    // The ambient slot is what this replaces — it must not be consulted.
    tabManager.setActiveParentTabId(null);

    const hosted = DockPointer.fromUrl(
      `/dock/project/${PROJ}/process/agentic_process-${PROC}/display/editor/markdown/typeid/markdown-${ASSET}`,
    );
    const doc = new Tab({
      id: nextTabId(),
      pointer: hosted.toJSON() ?? '',
      target_type: 'markdown',
      target_id: ASSET,
      project_id: PROJ,
      visible: true,
    });
    vi.spyOn(Tab, 'listAll').mockResolvedValue([host]);
    vi.spyOn(Tab, 'activateById').mockResolvedValue([]);
    const mint = vi.spyOn(Tab, 'getFromDockPointer').mockResolvedValue([doc]);

    await setupTab(hosted);

    // The parent edge comes from the URL, resolved by a pure store lookup — no
    // project resolve, no "which chat discusses this asset" query, no process
    // creation, none of which a route loader should ever await.
    expect(mint).toHaveBeenCalledTimes(1);
    expect(mint.mock.calls[0][1]).toMatchObject({ parentTabId: host.id });
  });

  it('falls back cleanly when the host tab is not open yet (cold link)', async () => {
    tabManager.adoptGlobal([]);
    tabManager.setActiveParentTabId(null);

    const hosted = DockPointer.fromUrl(
      `/dock/project/${PROJ}/process/agentic_process-${PROC}/display/editor/markdown/typeid/markdown-${ASSET}`,
    );
    vi.spyOn(Tab, 'listAll').mockResolvedValue([]);
    vi.spyOn(Tab, 'activateById').mockResolvedValue([]);
    const mint = vi.spyOn(Tab, 'getFromDockPointer').mockResolvedValue([]);

    await setupTab(hosted);

    expect(mint).toHaveBeenCalledTimes(1);
    expect(mint.mock.calls[0][1]?.parentTabId ?? null).toBeNull();
  });
});
