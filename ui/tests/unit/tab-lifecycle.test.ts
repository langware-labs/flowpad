import { Tab } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import {
  closeTabWithLifecycle,
  getTabLifecycle,
  registerTabContentAdapter,
  resetTabLifecycleForTests,
  setTabLifecycleForTests,
  setupTab,
  syncTabLifecycleWithTabs,
  TabLifecycleState,
} from '@src/tabs/tab-lifecycle';
import { ViewType } from '@src/types/ViewType';
import { afterEach, describe, expect, it, vi } from 'vitest';

function dock(id = '5e11aaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'): DockPointer {
  return new DockPointer(ViewType.SHELL, `shell-${id}`);
}

function tabFor(d: DockPointer, id = 'tab-1'): Tab {
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

afterEach(() => {
  vi.restoreAllMocks();
  resetTabLifecycleForTests();
});

describe('tab lifecycle registry', () => {
  it('moves successful setup from opening to opened', async () => {
    const d = dock();
    const tab = tabFor(d);
    vi.spyOn(Tab, 'getFromDockPointer').mockResolvedValue([tab]);

    await setupTab(d);

    expect(getTabLifecycle(d.tabHash)?.state).toBe(TabLifecycleState.Opened);
    expect(getTabLifecycle(d.tabHash)?.tabId).toBe(tab.id);
  });

  it('keeps a materialized tab visible when setup fails', async () => {
    const d = dock();
    const tab = tabFor(d);
    vi.spyOn(Tab, 'getFromDockPointer').mockResolvedValue([tab]);
    registerTabContentAdapter(ViewType.SHELL, {
      async setupTab() {
        throw new Error('attach failed');
      },
      async cleanupTab() {},
    });

    const result = await setupTab(d);

    expect(result.tab?.id).toBe(tab.id);
    expect(getTabLifecycle(d.tabHash)?.state).toBe(TabLifecycleState.OpenFailed);
    expect(getTabLifecycle(d.tabHash)?.error).toBe('attach failed');
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
      async setupTab() {
        return { tab: null };
      },
      async cleanupTab() {
        throw new Error('cleanup failed');
      },
    });

    await expect(closeTabWithLifecycle(tab)).rejects.toThrow('cleanup failed');

    expect(getTabLifecycle(d.tabHash)?.state).toBe(TabLifecycleState.CloseFailed);
    expect(getTabLifecycle(d.tabHash)?.error).toBe('cleanup failed');
  });

  it('moves close action failure from closing to close_failed', async () => {
    const d = dock();
    const tab = tabFor(d);
    vi.spyOn(Tab, 'closeById').mockRejectedValue(new Error('close failed'));

    await expect(closeTabWithLifecycle(tab)).rejects.toThrow('close failed');

    expect(getTabLifecycle(d.tabHash)?.state).toBe(TabLifecycleState.CloseFailed);
    expect(getTabLifecycle(d.tabHash)?.error).toBe('close failed');
  });

  it('clears lifecycle entries when tabs_changed removes the tab', async () => {
    const d = dock();
    const tab = tabFor(d);
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
