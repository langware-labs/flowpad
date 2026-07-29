import { act, renderHook } from '@testing-library/react';
import { ConnectionManager, Tab, type IEntity, type ITab } from '@sdk';
import { applyAllTabs, getAllTabsSnapshot } from '@src/tabs/all-tabs-store';
import { useSyncContentTabNames } from '@src/tabs/useTabs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tabId = '';
let targetId = '';
let listAllSpy: ReturnType<typeof vi.spyOn>;
let setNameSpy: ReturnType<typeof vi.spyOn>;

function row(overrides: Partial<ITab> = {}): ITab {
  return {
    id: tabId,
    pointer: '{"viewType":"assets","pointer":"editor/markdown"}',
    target_type: 'markdown',
    target_id: targetId,
    name: 'Old name',
    target_remote: false,
    ...overrides,
  };
}

async function emitData(data: Partial<IEntity>): Promise<void> {
  await act(async () => {
    ConnectionManager.getInstance().emit(
      'on_data_op',
      `markdown-${targetId}`,
      'update',
      data as IEntity,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useSyncContentTabNames remote invalidation', () => {
  beforeEach(() => {
    tabId = crypto.randomUUID();
    targetId = crypto.randomUUID();
    applyAllTabs([row()]);
    listAllSpy = vi.spyOn(Tab, 'listAll').mockImplementation(() => Promise.resolve(getAllTabsSnapshot()));
    setNameSpy = vi.spyOn(Tab, 'setNameById').mockResolvedValue([]);
  });

  afterEach(() => {
    applyAllTabs([]);
    vi.restoreAllMocks();
  });

  it('refreshes once for a remote-only change without writing the projection', async () => {
    const hook = renderHook(() => useSyncContentTabNames());
    await act(async () => {
      await Promise.resolve();
    });

    await emitData({ id: targetId, type: 'markdown', remote: true });

    expect(setNameSpy).not.toHaveBeenCalled();
    expect(listAllSpy).toHaveBeenCalledTimes(1);
    hook.unmount();
  });

  it('coalesces a combined name and remote change into one refresh', async () => {
    const hook = renderHook(() => useSyncContentTabNames());
    await act(async () => {
      await Promise.resolve();
    });

    await emitData({
      id: targetId,
      type: 'markdown',
      name: 'New name',
      remote: true,
    });

    expect(setNameSpy).toHaveBeenCalledOnce();
    expect(listAllSpy).toHaveBeenCalledTimes(1);
    hook.unmount();
  });

  it('ignores absent or unchanged remote and requires both target type and id', async () => {
    const hook = renderHook(() => useSyncContentTabNames());
    await act(async () => {
      await Promise.resolve();
    });

    await emitData({ id: targetId, type: 'markdown' });
    await emitData({ id: targetId, type: 'markdown', remote: false });
    await emitData({ id: targetId, type: 'skill', remote: true });

    expect(setNameSpy).not.toHaveBeenCalled();
    expect(listAllSpy).not.toHaveBeenCalled();
    hook.unmount();
  });
});
