/**
 * A warm tab switch must not rebuild the terminal.
 *
 * Reported as "every tab I jump to has a redraw", on sessions of every size —
 * so not a volume problem. `TerminalPanel`'s activation effect listed `isActive`
 * in its deps and reset `runtimeStatus` to 'idle' whenever the panel was not the
 * one on screen. The render gate turns 'idle'/'starting' into
 * `TerminalPanelStartingState` *instead of* `InteractiveTerminal` — a different
 * component in the same slot — so React unmounted a live xterm on every switch
 * away, and the trip back paid a fresh PtySync attach plus a full
 * `replayPtyStream` + `term.reset()`.
 *
 * Bisected to 2435a1f71 (v0.2.114), which moved `process.start()` out of the
 * route loader — where it ran once per LOAD — into this component, where the
 * effect re-fires per ACTIVATION. Confirmed by running v0.2.113 and v0.2.114
 * side by side in the real app: only 0.2.114 redraws.
 *
 * OBSERVATION POINT — the identity of the DOM node the terminal renders into.
 * React reuses that node for as long as the component stays mounted and creates
 * a new one when it remounts, so `toBe` on the node IS the unmount being
 * detected, not a stand-in for it. The real `InteractiveTerminal` is mounted
 * here (it survives jsdom; xterm only warns about `canvas.getContext`), so the
 * component under test and its child both run for real — nothing about the
 * mechanism is faked.
 *
 * Ambient-only mocks: dock navigation (the URL layer that drives which tab is
 * active) and agent context. Neither is the mechanism under test.
 */
import { type PropsWithChildren } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgenticProcess, connectionManager, Shell, Tab, tabManager } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';

const PROJECT_ID = 'c3f1a2b4-5d6e-4f70-8a91-b2c3d4e5f607';
const PROC_A = '36e631cb-a879-44ad-89c9-096ccc76735b';
const PROC_B = '4967ce30-cac4-495f-8639-66cc97c0a772';
const SHELL_A = '76688a8a-fa35-4d3b-a5be-d6fc8d432d7e';
const SHELL_B = '9c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f';

const dockA = new DockPointer(ViewType.SHELL, `agentic_process-${PROC_A}`);
const dockB = new DockPointer(ViewType.SHELL, `agentic_process-${PROC_B}`);
let currentDock: DockPointer = dockA;

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ currentDock, navigation: { openDock: vi.fn() } }),
  useCurrentDock: () => currentDock,
}));
vi.mock('@src/components/agent-layout/agent-layout', () => ({
  useAgentContext: () => ({ flow: null, project: { id: PROJECT_ID } }),
}));

import TabbedTerminal from '@src/components/terminal/TabbedTerminal';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const Wrap = ({ children }: PropsWithChildren) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);

function mkSession(procId: string, shellId: string): void {
  new AgenticProcess({
    id: procId,
    shell_id: shellId,
    project_id: PROJECT_ID,
    status: 'running',
    visible: true,
    pty_mode: true,
  } as never);
  new Shell({ id: shellId, project_id: PROJECT_ID } as never);
}

function mkTab(tabId: string, dock: DockPointer, targetId: string, lastActive: number): Tab {
  return new Tab({
    id: tabId,
    pointer: dock.toJSON(),
    target_type: 'agentic_process',
    target_id: targetId,
    project_id: PROJECT_ID,
    last_active_at: lastActive,
    visible: true,
  } as never);
}

beforeEach(() => {
  currentDock = dockA;
  mkSession(PROC_A, SHELL_A);
  mkSession(PROC_B, SHELL_B);
  vi.spyOn(connectionManager, 'waitForConnected').mockResolvedValue(undefined as never);
  vi.spyOn(AgenticProcess.prototype, 'start').mockResolvedValue(true as never);
});

afterEach(() => {
  cleanup();
  tabManager.adoptGlobal([]);
  tabManager.lifecycle.resetForTests();
  vi.restoreAllMocks();
});

describe('switching terminal tabs must not rebuild the terminal', () => {
  it('keeps the same terminal DOM node across a switch away and back', async () => {
    tabManager.adoptGlobal([
      mkTab('6fe6a58f-10ce-5e41-ae3e-8676067d9b43', dockA, PROC_A, 5_000),
      mkTab('1a2b3c4d-5e6f-5071-9b8c-1d2e3f4a5b6c', dockB, PROC_B, 1_000),
    ]);

    const view = render(
      <Wrap>
        <TabbedTerminal spawnProjectId={PROJECT_ID} />
      </Wrap>,
    );
    const settle = async () => {
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
    };
    const panelA = () => view.container.querySelector(`[data-session-id="agentic_process-${PROC_A}"]`);
    const goTo = async (dock: DockPointer) => {
      currentDock = dock;
      view.rerender(
        <Wrap>
          <TabbedTerminal spawnProjectId={PROJECT_ID} />
        </Wrap>,
      );
      await settle();
    };

    await settle();

    // Guard against a vacuous pass: A must really be showing a terminal, not the
    // startup spinner, or the node comparison below is between two spinners.
    expect(panelA(), 'tab A panel never rendered').not.toBeNull();
    expect(
      panelA()!.querySelector('[data-testid="terminal-panel-starting"]'),
      'tab A is still on the startup spinner — nothing to preserve',
    ).toBeNull();
    const terminalNode = panelA()!.firstElementChild;
    expect(terminalNode, 'tab A rendered no terminal').not.toBeNull();

    await goTo(dockB);
    await goTo(dockA);

    // THE ASSERTION: the very same element object is still there. A remount
    // would have produced a different node — that is the destroy+rebuild the
    // user sees as a redraw (fresh attach, replayPtyStream, term.reset()).
    expect(panelA()!.firstElementChild, 'tab A rebuilt its terminal on a warm switch').toBe(terminalNode);
  });
});
