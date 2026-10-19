/**
 * Closing the CURRENT terminal tab must not flash "This session has nothing to
 * display". The close hides the chip at once (lifecycle `Closing`) while the
 * navigation to the next tab is still loading, so the URL keeps naming the
 * closed tab for a moment. Caught live by the `tab_switch` sink
 * `terminal_active_tab_missing` naming the tab being closed. A tab that vanishes
 * without a close from this client (another window, a refusal) keeps the overlay.
 */
import { type PropsWithChildren } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgenticProcess, connectionManager, Shell, Tab, TabLifecycleState, tabKey, tabManager } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';

const PROJECT_ID = 'c3f1a2b4-5d6e-4f70-8a91-b2c3d4e5f607';
const PROC_A = '36e631cb-a879-44ad-89c9-096ccc76735b';
const PROC_B = '4967ce30-cac4-495f-8639-66cc97c0a772';
const SHELL_A = '76688a8a-fa35-4d3b-a5be-d6fc8d432d7e';
const SHELL_B = '9c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const TAB_A = '6fe6a58f-10ce-5e41-ae3e-8676067d9b43';
const TAB_B = '1a2b3c4d-5e6f-5071-9b8c-1d2e3f4a5b6c';

const dockA = new DockPointer(ViewType.SHELL, `agentic_process-${PROC_A}`);
const dockB = new DockPointer(ViewType.SHELL, `agentic_process-${PROC_B}`);

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ currentDock: dockA, navigation: { openDock: vi.fn() } }),
  useCurrentDock: () => dockA,
}));
vi.mock('@src/components/agent-layout/agent-layout', () => ({
  useAgentContext: () => ({ flow: null, project: { id: PROJECT_ID } }),
}));

import TabbedTerminal from '@src/components/terminal/TabbedTerminal';
import { TerminalPool } from '@src/components/terminal/TerminalPool';
import { terminalPool } from '@src/components/terminal/terminal-pool';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const Wrap = ({ children }: PropsWithChildren) => (
  <QueryClientProvider client={queryClient}>
    {children}
    <TerminalPool />
  </QueryClientProvider>
);

function mkTab(tabId: string, dock: DockPointer, targetId: string): Tab {
  return new Tab({
    id: tabId,
    pointer: dock.toJSON(),
    target_type: 'agentic_process',
    target_id: targetId,
    project_id: PROJECT_ID,
    last_active_at: 1_000,
    visible: true,
  } as never);
}

let tabA: Tab;
let tabB: Tab;

beforeEach(() => {
  for (const [proc, shell] of [
    [PROC_A, SHELL_A],
    [PROC_B, SHELL_B],
  ]) {
    new AgenticProcess({
      id: proc,
      shell_id: shell,
      project_id: PROJECT_ID,
      status: 'running',
      visible: true,
      pty_mode: true,
    } as never);
    new Shell({ id: shell, project_id: PROJECT_ID } as never);
  }
  vi.spyOn(connectionManager, 'waitForConnected').mockResolvedValue(undefined as never);
  vi.spyOn(AgenticProcess.prototype, 'start').mockResolvedValue(true as never);
  tabA = mkTab(TAB_A, dockA, PROC_A);
  tabB = mkTab(TAB_B, dockB, PROC_B);
  tabManager.adoptGlobal([tabA, tabB]);
});

afterEach(() => {
  cleanup();
  tabManager.resetForTests();
  terminalPool.resetForTests();
  vi.restoreAllMocks();
});

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const missing = (container: HTMLElement) => container.querySelector('[data-testid="terminal-active-tab-missing"]');

describe('closing the current terminal tab', () => {
  it('shows no dead-end overlay while the URL still names the tab being closed', async () => {
    const view = render(
      <Wrap>
        <TabbedTerminal spawnProjectId={PROJECT_ID} />
      </Wrap>,
    );
    await settle();
    expect(missing(view.container)).toBeNull();

    // handleClose: Closing first (the chip leaves), then the backend ack drops the row.
    act(() => {
      tabManager.lifecycle.set(tabKey(tabA), TabLifecycleState.Closing, { tabId: tabA.id });
    });
    await settle();
    expect(missing(view.container), 'overlay while closing').toBeNull();
    act(() => {
      tabManager.adoptGlobal([tabB]);
    });
    await settle();
    expect(missing(view.container), 'overlay after the close acked, before the URL moved').toBeNull();
  });

  it('still shows the overlay when the tab vanished without a close here', async () => {
    const view = render(
      <Wrap>
        <TabbedTerminal spawnProjectId={PROJECT_ID} />
      </Wrap>,
    );
    await settle();
    act(() => {
      tabManager.adoptGlobal([tabB]);
    });
    await settle();
    expect(missing(view.container)).not.toBeNull();
  });
});
