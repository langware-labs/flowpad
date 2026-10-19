/**
 * The workspace's active display re-points (and so re-labels) on every
 * `flow show`, even when its row also needs a parent edge.
 *
 * Live repro (ab-1): `flow show url https://metallb.io/…` then
 * `flow show url https://cert-manager.io/…`. The frame and address bar moved to
 * cert-manager, but the display's tab kept the first target's label. The row's
 * `parent_tab_id` did not match the host tab, so `materializeTab` took its
 * re-parent shortcut — which re-sends the ROW's own pointer and name, i.e. the
 * previous target — and returned before the display-repoint check ever ran. The
 * backend never heard about the new URL, so `ensure_tab`'s relabel clause (keyed
 * on the target having changed) never fired.
 */
import { Tab, tabManager } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { resetTabContentLifecycleForTests, setupTab } from '@src/tabs/tab-content-lifecycle';
import { afterEach, describe, expect, it, vi } from 'vitest';

const PROC = 'daa577df-eca5-4c2d-89c4-048e69ee742e';
const HOST = `agentic_process-${PROC}`;
const HOST_TAB = '00000000-0000-4000-8000-00000000feed';
const DISPLAY_TAB = '00000000-0000-4000-8000-0000000d15e1';

const METALLB = 'https://metallb.io/installation/';
const CERT_MANAGER = 'https://cert-manager.io/docs/installation/';

/** The active-display dock exactly as a `flow show url` navigation spells it. */
function displayDock(url: string): DockPointer {
  const pointer = DockPointer.forWebUrl(url).pointer;
  return DockPointer.fromUrl(`/dock/web-app/${pointer}?viewMode=vibe&host=${HOST}&activeDisplay=1`);
}

afterEach(() => {
  vi.restoreAllMocks();
  resetTabContentLifecycleForTests();
  tabManager.resetForTests();
});

describe('active display re-point', () => {
  it('sends the NEW target to the backend when the row also lacks its parent edge', async () => {
    const first = displayDock(METALLB);
    const next = displayDock(CERT_MANAGER);
    // Same row identity (host-keyed), different target — the premise of the bug.
    expect(next.tabHash).toBe(first.tabHash);
    expect(next.toJSON()).not.toBe(first.toJSON());

    const hostTab = new Tab({
      id: HOST_TAB,
      pointer: DockPointer.forShell(HOST).toJSON() ?? '',
      target_type: 'agentic_process',
      target_id: PROC,
      visible: true,
    });
    const displayRow = new Tab({
      id: DISPLAY_TAB,
      pointer: first.toJSON() ?? '',
      name: 'metallb.io',
      visible: true,
      // Not the host tab: `needsReparent` is true, which is what routed the
      // re-show into the shortcut that replays the stale row.
      parent_tab_id: null,
    });
    tabManager.adoptGlobal([hostTab, displayRow]);

    const repointed = new Tab({ ...displayRow, pointer: next.toJSON() ?? '', name: 'cert-manager.io', parent_tab_id: HOST_TAB });
    vi.spyOn(Tab, 'listAll').mockResolvedValue([hostTab, repointed]);
    vi.spyOn(Tab, 'activateById').mockResolvedValue(undefined);
    const replayStale = vi.spyOn(Tab, 'newTab').mockResolvedValue([hostTab, displayRow]);
    const ensure = vi.spyOn(Tab, 'getFromDockPointer').mockResolvedValue({ tabs: [repointed], created: false });

    await setupTab(next);

    // The row is never re-sent with the previous target's pointer and label…
    for (const call of replayStale.mock.calls) {
      expect(call[0]).not.toBe(first.toJSON());
      expect((call[1] as { name?: string | null } | undefined)?.name).not.toBe('metallb.io');
    }
    // …the new dock goes through the ensure seam (which names it from the URL host)
    // and still carries the host edge.
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(ensure.mock.calls[0][0].toJSON?.()).toBe(next.toJSON());
    expect(ensure.mock.calls[0][1]).toMatchObject({ parentTabId: HOST_TAB });
  });
});
