/**
 * A vibe window must not rebuild a session tab that another window closed.
 *
 * Reported reproduction (instance `dev`, :9008 / :4098) — reproduced verbatim:
 *   1. Start a session in browser tab A, in TERMINAL (advanced) mode.
 *   2. Open browser tab B on the same session.
 *   3. In tab B, switch to VIBE.
 *   4. Back in tab A, close the session's tab → it pops straight back.
 * Measured live while closing through the backend action — no reload anywhere:
 *   14:44:13.521  tab=0     ← the close lands
 *   14:44:13.937  tab=1     ← back 416 ms later, and stays
 *
 * The culprit is `useVibeWorkspaceSessionHost` (use-vibe-workspace-session.ts).
 * It is a LIVE hook in the mounted vibe workspace — no reload needed — and its
 * rule was "my session has no tab ⇒ create one":
 *   useEffect(() => {
 *     if (!active || !session || session.processTab) return;
 *     void setupTabAndAdopt(session.processDock);
 *   }, [active, session, session.processTab, session.processDock]);
 * `session.processTab` is in the deps, so the moment tab A's close removes the
 * row the effect re-runs, the `processTab` guard now PASSES (precisely because
 * the tab is gone), and `setupTabAndAdopt` → `materializeTab` finds no existing
 * tab, falls through to `ensureDock` → `new_tab` → `ensure_tab`, which sets
 * `visible=True` (tab.py:901). The close is silently undone.
 *
 * NOT the adoption branch — the vibe window logged its own decision at
 * `materializeTab`: `addressesAdoptable:false, optsParent:null`, so
 * `needsReparent` was false and that branch never ran.
 *
 * The two null-`processTab` cases need OPPOSITE answers, which is the whole
 * fix: a cold open (never had a tab) must still mint one; a tab that existed
 * and vanished means another window closed the session, and this window must
 * leave instead — via the same landing rule both tab strips use
 * (next tab → project home → base URL).
 *
 * Entry is the real hook the product mounts. Observation points are
 * `Tab.getFromDockPointer` (the `new_tab`/`ensure_tab` round trip that re-shows
 * the row — the defect itself) and `openDock` (where the window goes instead).
 * Only the wire and ambient dock navigation are stubbed.
 */
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgenticProcess, Tab, tabManager } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';

const PROJECT_ID = '11317f4e-ca67-58aa-b06c-4c5a39a16844';
const SESSION_ID = '8282a288-3fd2-4bd7-9bcb-09860c48db5c';

const sessionDock = new DockPointer(ViewType.SHELL, `agentic_process-${SESSION_ID}`);
const openDock = vi.fn();

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ currentDock: sessionDock, navigation: { openDock, closeDock: openDock } }),
  useCurrentDock: () => sessionDock,
}));

import { useVibeWorkspaceSessionHost } from '@src/pages/flow-page/use-vibe-workspace-session';

function sessionTab(): Tab {
  return new Tab({
    id: 'aef3407f-8792-56e8-80f6-a9e29d1f81be',
    pointer: sessionDock.toJSON(),
    target_type: 'agentic_process',
    target_id: SESSION_ID,
    project_id: PROJECT_ID,
    parent_tab_id: null,
    name: 'hi',
    last_active_at: 5_000,
    visible: true,
  } as never);
}

/** A sibling that survives — where the window should land after the close. */
function siblingTab(): Tab {
  return new Tab({
    id: '6a1d1fa5-1e5d-5933-8ad0-c78679069e18',
    pointer: new DockPointer(ViewType.SHELL, 'agentic_process-ad92d6da-820d-4739-9750-7b22b31d110f').toJSON(),
    target_type: 'agentic_process',
    target_id: 'ad92d6da-820d-4739-9750-7b22b31d110f',
    project_id: PROJECT_ID,
    last_active_at: 1_000,
    visible: true,
  } as never);
}

let ensureDockSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  new AgenticProcess({ id: SESSION_ID, project_id: PROJECT_ID, status: 'running', visible: true } as never);
  // The wire only — the unit tier has no backend.
  vi.spyOn(Tab, 'listAll').mockImplementation(() => Promise.resolve([...tabManager.getSnapshot()]));
  vi.spyOn(Tab, 'newTab').mockImplementation(() => Promise.resolve([...tabManager.getSnapshot()]));
  vi.spyOn(Tab, 'activateById').mockImplementation(() => Promise.resolve());
  // THE OBSERVATION POINT — this round trip is what re-shows the closed row.
  ensureDockSpy = vi
    .spyOn(Tab, 'getFromDockPointer')
    .mockImplementation(() => Promise.resolve([...tabManager.getSnapshot()]));
});

afterEach(() => {
  tabManager.adoptGlobal([]);
  tabManager.lifecycle.resetForTests();
  openDock.mockReset();
  vi.restoreAllMocks();
});

describe('vibe workspace host, when another window closes its session', () => {
  it('does not rebuild the tab', async () => {
    tabManager.adoptGlobal([sessionTab(), siblingTab()]);

    // The vibe window is mounted on the session and HAS its tab.
    const withTab = { processTab: sessionTab(), processDock: sessionDock, processId: SESSION_ID, onProcessUrl: true };
    const { rerender } = renderHook(({ session }) => useVibeWorkspaceSessionHost(session as never, true), {
      initialProps: { session: withTab },
    });
    await act(async () => {
      await Promise.resolve();
    });
    ensureDockSpy.mockClear();
    openDock.mockReset();

    // Window A closes the session: the row leaves the shared list, so this
    // window's resolved session loses its tab. No reload — just new props.
    await act(async () => {
      tabManager.adoptGlobal([siblingTab()]);
      rerender({ session: { ...withTab, processTab: null } });
      await Promise.resolve();
    });

    expect(ensureDockSpy).not.toHaveBeenCalled(); // must not re-mint the closed tab
  });

  it('still mints the tab on a cold open that never had one', async () => {
    tabManager.adoptGlobal([siblingTab()]);
    const coldOpen = { processTab: null, processDock: sessionDock, processId: SESSION_ID, onProcessUrl: true };

    renderHook(() => useVibeWorkspaceSessionHost(coldOpen as never, true));
    await act(async () => {
      await Promise.resolve();
    });

    expect(ensureDockSpy).toHaveBeenCalled();
  });
});
