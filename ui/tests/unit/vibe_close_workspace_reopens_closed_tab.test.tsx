/**
 * Vibe mode: closing a workspace must not land on a tab that is mid-close —
 * doing so re-creates that tab and restarts its worker ("I close the tab and it
 * keeps reopening").
 *
 * The reported failure, from the prod log (instance `prod`, 2026-08-31 IDT):
 *
 *   12:35:50  user closes the tab of claude_session 84fd5799 (agentic_process
 *             38d36808) — backend logs `AgenticProcess 38d36808: close`
 *   12:35:54  user closes the NEXT workspace they landed on
 *   12:35:54  …and 145 ms later the backend spawns
 *             `claude --resume 84fd5799` again and re-shows the tab row.
 *
 * `ensure_tab` (flow_sdk/builtin/tab.py) is the sole `visible=False → True`
 * path and it is loader-driven, so the reopen is an automatic NAVIGATION back
 * to the closed process dock. `handleCloseWorkspace` picks that landing spot
 * from the RAW `allTabs` snapshot — it never applies
 * `lifecycle.excludeClosing`, which this same component already applies to its
 * children (workspace-child-strip.tsx) and which the global strip applies to
 * its whole working set (unified-tab-strip.tsx). A tab closed moments earlier
 * is still in the snapshot (the close is async) and, ranked by
 * `last_active_at`, is by definition the most recent candidate — so it wins.
 *
 * Entry point is the real one: the `close-vibe-workspace` button on a real
 * `WorkspaceChildStrip`. The Closing marker is established by the real
 * `closeTabWithLifecycle` (left in flight, exactly as in production, where the
 * bug window IS the in-flight close). Nothing on the path under test is mocked:
 * the snapshot, the lifecycle registry, the candidate filter and the resolver
 * are all real product code. Dock navigation is mocked only as the observation
 * point — it is where the answer is read, not part of the mechanism.
 */
import { type PropsWithChildren } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Tab, TabLifecycleState, tabKey, tabManager } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';

const PROJECT_ID = 'b1d0f2a4-6c3e-4f21-9a8b-2d5e7c1a4f30';

/** The workspace being closed (its anchor/display tab). */
const ANCHOR_PROCESS_ID = '38d36808-ef23-4b7a-8813-f8cf3a271208';
/** The process the user closed a moment ago — the one that must NOT come back. */
const CLOSED_PROCESS_ID = '7248b002-4676-42c4-bbce-56a68c5c2358';
/** A genuinely open sibling — the correct landing spot. */
const SURVIVING_PROCESS_ID = '1f89767a-324f-41d6-9c2f-48caece1ee17';

const anchorDock = new DockPointer(ViewType.SHELL, `agentic_process-${ANCHOR_PROCESS_ID}`);
const closedDock = new DockPointer(ViewType.SHELL, `agentic_process-${CLOSED_PROCESS_ID}`);
const survivingDock = new DockPointer(ViewType.SHELL, `agentic_process-${SURVIVING_PROCESS_ID}`);

const openDock = vi.fn();
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ currentDock: anchorDock, navigation: { openDock } }),
  useCurrentDock: () => anchorDock,
}));

import { WorkspaceChildStrip } from '@src/pages/flow-page/workspace-child-strip';
import { closeTabWithLifecycle } from '@src/tabs/tab-content-lifecycle';
import { TooltipProvider } from '@src/components/ui/tooltip';

const queryClient = new QueryClient();
const Wrap = ({ children }: PropsWithChildren) => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>{children}</TooltipProvider>
  </QueryClientProvider>
);

function tab(id: string, dock: DockPointer, targetId: string, lastActiveAt: number): Tab {
  return new Tab({
    id,
    pointer: dock.toJSON(),
    target_type: 'agentic_process',
    target_id: targetId,
    project_id: PROJECT_ID,
    last_active_at: lastActiveAt,
    visible: true,
  } as never);
}

// Recency is what `resolveNext` ranks on, so the just-closed tab is deliberately
// the MOST recent — that is precisely why it wins the selection in production.
const anchorTab = tab('0f1a2b3c-4d5e-5f60-8a9b-0c1d2e3f4a5b', anchorDock, ANCHOR_PROCESS_ID, 1_000);
const survivingTab = tab('1a2b3c4d-5e6f-5071-9b8c-1d2e3f4a5b6c', survivingDock, SURVIVING_PROCESS_ID, 2_000);
const closedTab = tab('2b3c4d5e-6f70-5182-8c9d-2e3f4a5b6c7d', closedDock, CLOSED_PROCESS_ID, 3_000);

// The unit tier has no backend, so the TRANSPORT (`Tab.listAll` / `closeById`,
// the two wire calls the handler fans out to) is stubbed — the wire, never the
// mechanism. Both fire strictly AFTER the landing decision this test asserts
// on, so they cannot influence the result; left live they only surface as
// ERR_NETWORK noise that could be mistaken for the failure under test. The
// snapshot, the lifecycle registry, the candidate filter and `resolveNext` are
// all real.
beforeAll(() => {
  vi.spyOn(Tab, 'listAll').mockImplementation(() => Promise.resolve([...tabManager.getSnapshot()]));
  vi.spyOn(Tab, 'closeById').mockImplementation(() => Promise.resolve([...tabManager.getSnapshot()]));
});
afterAll(() => vi.restoreAllMocks());

afterEach(() => {
  cleanup();
  tabManager.adoptGlobal([]);
  tabManager.lifecycle.resetForTests();
  openDock.mockReset();
});

describe('vibe: closing a workspace while another tab is still closing', () => {
  it('does not land on (and therefore reopen) the tab that is mid-close', () => {
    // The snapshot still holds the just-closed tab: its close is in flight, and
    // `adoptGlobal` re-adopts pre-close `list_all` responses that were issued
    // before it committed.
    tabManager.adoptGlobal([anchorTab, survivingTab, closedTab]);

    // Real close, deliberately NOT awaited — production's bug window is exactly
    // the in-flight close, where `Closing` is set but the row is still listed.
    void closeTabWithLifecycle(closedTab);
    expect(tabManager.lifecycle.get(tabKey(closedTab))?.state).toBe(TabLifecycleState.Closing);

    render(
      <Wrap>
        <WorkspaceChildStrip processTab={anchorTab} processDock={anchorDock} projectId={PROJECT_ID} />
      </Wrap>,
    );

    fireEvent.click(screen.getByTestId('close-vibe-workspace'));

    expect(openDock).toHaveBeenCalled();
    const landed = openDock.mock.calls.at(-1)![0] as { pointer?: string } | null;
    expect(landed?.pointer ?? '').not.toContain(CLOSED_PROCESS_ID);
    expect(landed?.pointer ?? '').toContain(SURVIVING_PROCESS_ID);
  });
});
