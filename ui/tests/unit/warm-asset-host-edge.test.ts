/**
 * A warm open of an already-open file tab still tells the backend about a NEW
 * host edge.
 *
 * Discuss puts the file on screen under its chat: the same file tab, now with
 * `?host=agentic_process-<id>`. The warm path ("same key, already opened → just
 * set up the content") asks the backend for nothing, so the file used to stay a
 * top-level tab until a cold reload re-parented it. The loader now treats a host
 * edge the row does not carry as stale, like a re-pointed active display.
 */
import { Tab, TabLifecycleState, tabManager } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { resetTabContentLifecycleForTests, setupTab } from '@src/tabs/tab-content-lifecycle';
import { afterEach, describe, expect, it, vi } from 'vitest';

const PROC = 'daa577df-eca5-4c2d-89c4-048e69ee742e';
const HOST = `agentic_process-${PROC}`;
const HOST_TAB = '00000000-0000-4000-8000-00000000feed';
const FILE_TAB = '00000000-0000-4000-8000-0000000f11e0';

afterEach(() => {
  vi.restoreAllMocks();
  resetTabContentLifecycleForTests();
  tabManager.resetForTests();
});

describe('warm file tab, new host edge', () => {
  it('re-parents the open file under the host instead of the cheap warm path', async () => {
    const plain = DockPointer.forFile('/w/p/plan.md');
    const hosted = plain.withHost(HOST);
    expect(hosted.tabHash).toBe(plain.tabHash);

    const hostTab = new Tab({
      id: HOST_TAB,
      pointer: DockPointer.forShell(HOST).toJSON() ?? '',
      target_type: 'agentic_process',
      target_id: PROC,
      visible: true,
    });
    const fileRow = new Tab({ id: FILE_TAB, pointer: plain.toJSON() ?? '', name: 'plan.md', visible: true, parent_tab_id: null });
    tabManager.adoptGlobal([hostTab, fileRow]);
    // The file tab was opened before: the warm path would apply.
    tabManager.lifecycle.set(hosted.tabHash ?? '', TabLifecycleState.Opened, { tabId: FILE_TAB });

    const adopted = new Tab({ ...fileRow, parent_tab_id: HOST_TAB });
    vi.spyOn(Tab, 'listAll').mockResolvedValue([hostTab, adopted]);
    vi.spyOn(Tab, 'activateById').mockResolvedValue(undefined);
    const reparent = vi.spyOn(Tab, 'newTab').mockResolvedValue([hostTab, adopted]);
    const ensure = vi.spyOn(Tab, 'getFromDockPointer').mockResolvedValue({ tabs: [adopted], created: false });

    await setupTab(hosted);

    const parents = [
      ...reparent.mock.calls.map((c) => (c[1] as { parentTabId?: string | null } | undefined)?.parentTabId),
      ...ensure.mock.calls.map((c) => (c[1] as { parentTabId?: string | null } | undefined)?.parentTabId),
    ];
    expect(parents).toContain(HOST_TAB);
  });
});
