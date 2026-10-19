/**
 * A terminal outlives the layout that shows it (dock-loading invariant I6).
 *
 * Reported 2026-09-27 on prod 0.2.176: Codex shell tab → click a report link in
 * the terminal (`/dock/project/<P>/editor/markdown/…`) → back to Codex = empty
 * xterm for seconds, then a fresh `/open` + full pty-stream replay.
 *
 * `flow-page.tsx` picks a DIFFERENT layout component for an asset URL
 * (`AssetVibeWorkspace`) than for a shell URL (`ContentPanel`). React unmounts
 * one subtree and mounts the other, and the terminal body went with it — the
 * keep-alive of b9afd0ce0 only held while both tabs rendered through the same
 * `ContentPanel` instance.
 *
 * The two layouts here are stand-ins with the one property that matters: they
 * are different component types in the same slot, so React unmounts whatever
 * the first rendered. The terminal body (`TabbedTerminal`) and the pool that
 * owns runtimes (`TerminalPool`, mounted once above every layout, as RootLayout
 * does) are real, and so is `InteractiveTerminal` under them.
 *
 * OBSERVATION POINT — the identity of the terminal's DOM node, as in
 * terminal_tab_switch_keeps_xterm_mounted.test.tsx: a remount creates a new
 * node, so `toBe` IS the rebuild being detected. `start()` counts the backend
 * `/open` calls the rebuild would pay.
 */
import { type PropsWithChildren } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgenticProcess, connectionManager, Shell, Tab, tabManager } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';

const PROJECT_ID = 'c3f1a2b4-5d6e-4f70-8a91-b2c3d4e5f607';
const PROC = '36e631cb-a879-44ad-89c9-096ccc76735b';
const SHELL = '76688a8a-fa35-4d3b-a5be-d6fc8d432d7e';
const TAB = '6fe6a58f-10ce-5e41-ae3e-8676067d9b43';

const shellDock = new DockPointer(ViewType.SHELL, `agentic_process-${PROC}`);
const assetDock = DockPointer.fromUrl(
  `/dock/project/${PROJECT_ID}/editor/markdown/typeid/markdown-f745759c-9113-4057-a82f-883e472e2933`,
);
let currentDock: DockPointer = shellDock;

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ currentDock, navigation: { openDock: vi.fn() } }),
  useCurrentDock: () => currentDock,
}));
vi.mock('@src/components/agent-layout/agent-layout', () => ({
  useAgentContext: () => ({ flow: null, project: { id: PROJECT_ID } }),
}));

import TabbedTerminal from '@src/components/terminal/TabbedTerminal';
import { TerminalPool } from '@src/components/terminal/TerminalPool';
import { terminalPool } from '@src/components/terminal/terminal-pool';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

/** The shell URL's layout: the terminal body is its content. */
const ShellLayout = () => (
  <div data-testid="shell-layout" style={{ height: 600 }}>
    <TabbedTerminal className="h-full" spawnProjectId={PROJECT_ID} />
  </div>
);
/** The asset URL's layout: a different component type — no terminal at all. */
const AssetLayout = () => <div data-testid="asset-layout">markdown editor</div>;

const App = ({ children }: PropsWithChildren) => (
  <QueryClientProvider client={queryClient}>
    {children}
    <TerminalPool />
  </QueryClientProvider>
);

const layoutFor = (dock: DockPointer) => (dock.viewType === ViewType.SHELL ? <ShellLayout /> : <AssetLayout />);

beforeEach(() => {
  currentDock = shellDock;
  new AgenticProcess({
    id: PROC,
    shell_id: SHELL,
    project_id: PROJECT_ID,
    status: 'running',
    visible: true,
    pty_mode: true,
  } as never);
  new Shell({ id: SHELL, project_id: PROJECT_ID } as never);
  tabManager.adoptGlobal([
    new Tab({
      id: TAB,
      pointer: shellDock.toJSON(),
      target_type: 'agentic_process',
      target_id: PROC,
      project_id: PROJECT_ID,
      last_active_at: 5_000,
      visible: true,
    } as never),
  ]);
  vi.spyOn(connectionManager, 'waitForConnected').mockResolvedValue(undefined as never);
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

describe('a terminal outlives the layout that shows it', () => {
  it('keeps the same xterm node and does not re-open across shell → asset layout → shell', async () => {
    const start = vi.spyOn(AgenticProcess.prototype, 'start').mockResolvedValue(true as never);
    const view = render(<App>{layoutFor(currentDock)}</App>);
    await settle();

    const panel = () => view.container.querySelector(`[data-session-id="agentic_process-${PROC}"]`);
    expect(panel(), 'the shell tab never rendered a panel').not.toBeNull();
    expect(panel()!.querySelector('[data-testid="terminal-panel-starting"]'), 'still on the spinner').toBeNull();
    const terminalNode = panel()!.firstElementChild;
    expect(terminalNode, 'the shell tab rendered no terminal').not.toBeNull();
    expect(start).toHaveBeenCalledTimes(1);

    // The report link: a different layout component takes the slot.
    currentDock = assetDock;
    view.rerender(<App>{layoutFor(currentDock)}</App>);
    await settle();
    expect(view.queryByTestId('shell-layout')).toBeNull();
    expect(panel(), 'the terminal was destroyed with the layout that showed it').not.toBeNull();
    expect(panel()!.getAttribute('data-active')).toBe('false');

    // Back to the Codex tab.
    currentDock = shellDock;
    view.rerender(<App>{layoutFor(currentDock)}</App>);
    await settle();

    expect(panel()!.firstElementChild, 'the terminal was rebuilt after the layout swap').toBe(terminalNode);
    expect(panel()!.getAttribute('data-active')).toBe('true');
    expect(view.getByTestId('shell-layout').contains(panel()), 'the terminal is not shown in the new layout').toBe(
      true,
    );
    expect(start, 'the round trip paid a second /open').toHaveBeenCalledTimes(1);
  });
});
