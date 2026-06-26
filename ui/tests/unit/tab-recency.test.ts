/**
 * `stampTabRecencyForTarget` (tab-recency.ts) — on select, stamp recency on the
 * Tab the close-resolver reads. Two resolution paths:
 *   1. warm all-tabs snapshot (no network) — the common case.
 *   2. snapshot-miss fallback to `refreshAllTabs()` (→ `Tab.listAll()`) — for a
 *      tab materialized this same load that hasn't been adopted into the store yet.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Tab, type TabRow } from '@sdk';
import { applyAllTabs, getAllTabsSnapshot } from '@src/tabs/all-tabs-store';
import { stampTabRecencyForTarget } from '@src/tabs/tab-recency';

const SHELL_ID = '5e11aaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TAB_ID = '40000000-0000-4000-8000-000000000001';

function shellTabRow(): TabRow {
  return {
    id: TAB_ID,
    pointer: `shell|shell-${SHELL_ID}`,
    target_type: 'shell',
    target_id: SHELL_ID,
    project_id: null,
    name: 'Shell',
    icon_key: 'shell',
    worktree: false,
    tab_order: 0,
    last_active_at: null,
    status: 'running',
    is_disabled: false,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  applyAllTabs([]);
});

describe('stampTabRecencyForTarget', () => {
  it('activates the tab resolved from the warm snapshot (no network)', async () => {
    applyAllTabs([shellTabRow()]);
    const activate = vi.spyOn(Tab, 'activateById').mockResolvedValue(undefined);
    const listAll = vi.spyOn(Tab, 'listAll').mockResolvedValue([]);

    stampTabRecencyForTarget('shell', SHELL_ID);
    await Promise.resolve();

    expect(activate).toHaveBeenCalledWith(TAB_ID);
    expect(listAll).not.toHaveBeenCalled(); // snapshot hit — never hits the network
  });

  it('falls back to Tab.listAll when the tab is not yet in the snapshot', async () => {
    applyAllTabs([]); // cold snapshot
    const activate = vi.spyOn(Tab, 'activateById').mockResolvedValue(undefined);
    const listAll = vi.spyOn(Tab, 'listAll').mockResolvedValue([new Tab(shellTabRow())]);

    stampTabRecencyForTarget('shell', SHELL_ID);
    // Drain the fallback promise chain (listAll → find → activateById).
    await vi.waitFor(() => expect(activate).toHaveBeenCalledWith(TAB_ID));

    expect(listAll).toHaveBeenCalledTimes(1);
  });

  it('no-ops (no activate, no network) when the target genuinely has no tab', async () => {
    applyAllTabs([]);
    const activate = vi.spyOn(Tab, 'activateById').mockResolvedValue(undefined);
    vi.spyOn(Tab, 'listAll').mockResolvedValue([]); // fallback finds nothing

    stampTabRecencyForTarget('shell', SHELL_ID);
    await Promise.resolve();
    await Promise.resolve();

    expect(activate).not.toHaveBeenCalled();
    expect(getAllTabsSnapshot()).toEqual([]);
  });
});
