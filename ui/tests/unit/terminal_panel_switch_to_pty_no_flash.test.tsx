/**
 * Chat → terminal must not flash "This session has nothing to display".
 *
 * `switchMode` stages `pty_mode=true` before its request; the shell id only
 * lands with the response. A panel readied as a headless chat read that gap as
 * "not headless, no shell" and painted the error state for ~400 ms (caught live
 * by the `tab_switch` sink `terminal_panel_nothing_to_display`, via=view_mode).
 * The gap must show the starting state. Once a shell has been seen, a later
 * shell-less PTY is a real failure and still shows the error.
 */
import { type PropsWithChildren } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgenticProcess, connectionManager, dataManager, Shell, Tab, tabManager } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';

const PROJECT_ID = 'c3f1a2b4-5d6e-4f70-8a91-b2c3d4e5f607';
const PROC = '36e631cb-a879-44ad-89c9-096ccc76735b';
const SHELL = '76688a8a-fa35-4d3b-a5be-d6fc8d432d7e';
const TAB = '6fe6a58f-10ce-5e41-ae3e-8676067d9b43';
const dock = new DockPointer(ViewType.SHELL, `agentic_process-${PROC}`);

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ currentDock: dock, navigation: { openDock: vi.fn() } }),
  useCurrentDock: () => dock,
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

let proc: AgenticProcess;

beforeEach(() => {
  proc = new AgenticProcess({
    id: PROC,
    project_id: PROJECT_ID,
    status: 'running',
    visible: false,
    pty_mode: false,
  } as never);
  new Shell({ id: SHELL, project_id: PROJECT_ID } as never);
  vi.spyOn(connectionManager, 'waitForConnected').mockResolvedValue(undefined as never);
  vi.spyOn(AgenticProcess.prototype, 'start').mockResolvedValue(true as never);
  vi.spyOn(AgenticProcess.prototype, 'switchMode').mockResolvedValue(undefined);
  tabManager.adoptGlobal([
    new Tab({
      id: TAB,
      pointer: dock.toJSON(),
      target_type: 'agentic_process',
      target_id: PROC,
      project_id: PROJECT_ID,
      last_active_at: 1_000,
      visible: true,
    } as never),
  ]);
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

async function update(fields: Partial<Pick<AgenticProcess, 'pty_mode' | 'shell_id'>>): Promise<void> {
  act(() => {
    Object.assign(proc, fields);
    dataManager.notifyEntityChanged(proc);
  });
  await settle();
}

describe('TerminalPanel chat → terminal switch', () => {
  it('shows the starting state, never the error, until the shell arrives', async () => {
    const view = render(
      <Wrap>
        <TabbedTerminal spawnProjectId={PROJECT_ID} />
      </Wrap>,
    );
    await settle();
    const q = (id: string) => view.container.querySelector(`[data-testid="${id}"]`);
    expect(q('terminal-panel-error')).toBeNull();

    // The switch's optimistic stage: terminal mode, no shell yet.
    await update({ pty_mode: true });
    expect(q('terminal-panel-error'), 'flashed nothing-to-display mid-switch').toBeNull();
    expect(q('terminal-panel-starting')).not.toBeNull();

    // The response lands the shell.
    await update({ shell_id: SHELL });
    expect(q('terminal-panel-error')).toBeNull();
    expect(q('terminal-panel-starting')).toBeNull();

    // A shell-less PTY after one was seen is a real failure.
    await update({ shell_id: '' });
    expect(q('terminal-panel-error')).not.toBeNull();
  });
});
