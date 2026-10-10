/**
 * A process is ONE tab whether it is shown as the Vibe host (`/dock/vibe/…`) or as
 * a shell (`/dock/shell/…`): the Vibe dock's tabHash folds onto the shell's. The
 * row's STORED pointer is what its chip reopens, so landing on the other
 * presentation re-points it — in the background (I4: nothing on screen waits), and
 * only when it actually changed (a warm revisit asks the backend for nothing).
 */
import { Tab, tabManager } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { resetTabContentLifecycleForTests, setupTab } from '@src/tabs/tab-content-lifecycle';
import { afterEach, describe, expect, it, vi } from 'vitest';

const PROC = 'daa577df-eca5-4c2d-89c4-048e69ee742e';
const PTR = `agentic_process-${PROC}`;
const TAB_ID = '00000000-0000-4000-8000-00000000feed';
const vibe = DockPointer.fromUrl(`/dock/vibe/${PTR}`);
const shell = DockPointer.fromUrl(`/dock/shell/${PTR}`);

function rowStoredAs(dock: DockPointer): Tab {
  return new Tab({
    id: TAB_ID,
    pointer: dock.toJSON() ?? '',
    target_type: 'agentic_process',
    target_id: PROC,
    project_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    visible: true,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  resetTabContentLifecycleForTests();
  tabManager.resetForTests();
});

describe('Vibe host tab re-point', () => {
  it('the two presentations are one tab identity', () => {
    expect(vibe.tabHash).toBe(shell.tabHash);
    expect(vibe.toJSON()).not.toBe(shell.toJSON());
  });

  it.each([
    ['shell → Vibe', shell, vibe],
    ['Vibe → shell', vibe, shell],
  ])('%s re-points the stored pointer without blocking the open', async (_what, stored, landed) => {
    const row = rowStoredAs(stored);
    tabManager.adoptGlobal([row]);
    vi.spyOn(Tab, 'listAll').mockResolvedValue([rowStoredAs(landed)]);
    vi.spyOn(Tab, 'activateById').mockResolvedValue(undefined);
    let release: () => void = () => {};
    const ensure = vi.spyOn(Tab, 'getFromDockPointer').mockImplementation(
      () => new Promise((resolve) => (release = () => resolve({ tabs: [rowStoredAs(landed)], created: false }))),
    );

    const result = await setupTab(landed); // resolves while the re-point is still pending

    expect(result.tab?.id).toBe(TAB_ID);
    expect(ensure).toHaveBeenCalledTimes(1);
    expect((ensure.mock.calls[0][0] as DockPointer).toJSON()).toBe(landed.toJSON());
    release();
  });

  it('a revisit in the same presentation asks the backend for nothing', async () => {
    tabManager.adoptGlobal([rowStoredAs(vibe)]);
    vi.spyOn(Tab, 'activateById').mockResolvedValue(undefined);
    const ensure = vi.spyOn(Tab, 'getFromDockPointer');
    const newTab = vi.spyOn(Tab, 'newTab');

    await setupTab(vibe);

    expect(ensure).not.toHaveBeenCalled();
    expect(newTab).not.toHaveBeenCalled();
  });
});
