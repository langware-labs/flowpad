/**
 * The pool gives back the terminal of an agent that ENDED, once its tab is not the one shown
 * (docs/navigation/dock-loading.md, I6).
 *
 * A runtime lives as long as its tab — with one narrowing. A process that stopped or failed has
 * no PTY left to follow, so keeping its xterm, sync session and panel tree mounted behind another
 * tab buys nothing. The pool drops that panel when the process ends behind another tab, or when
 * the user leaves a tab whose process already ended. The tab stays open; visiting it again mounts
 * the panel cold, and the panel starts the agent again as a reopened tab does.
 *
 * What must never go: the panel on screen, a running agent's, a plain shell's, and a headless
 * chat's (no terminal to free, and a long chat costs seconds to draw again).
 *
 * OBSERVATION POINT — the panel element in the document and the pool's own `has(key)`. The real
 * `TabbedTerminal`, `TerminalPool`, `TerminalPanel` and `InteractiveTerminal` run against the
 * real store; a process's end arrives as the store's own data op, the way the WS delivers the
 * backend's save. Dock navigation and agent context are the only mocks, as in
 * terminal-pool-switch-moves-nothing.
 */
import { type PropsWithChildren } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgenticProcess, connectionManager, dataManager, ProcessStatus, Shell, Tab, tabManager } from '@sdk';
import { DockPointer, VIEW_MODE_PARAM } from '@src/navigation/DockPointer';
import { ViewMode } from '@src/contexts/view-mode-context';
import { ViewType } from '@src/types/ViewType';

const PROJECT_ID = 'c3f1a2b4-5d6e-4f70-8a91-b2c3d4e5f607';
const PROC_A = '36e631cb-a879-44ad-89c9-096ccc76735b';
const PROC_B = '4967ce30-cac4-495f-8639-66cc97c0a772';
const PROC_CHAT = '5b0c7d1e-2f3a-4b4c-8d5e-6f7a8b9c0d1e';
const SHELL_A = '76688a8a-fa35-4d3b-a5be-d6fc8d432d7e';
const SHELL_B = '9c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const PLAIN_SHELL = '2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a';
const TAB_A = '6fe6a58f-10ce-5e41-ae3e-8676067d9b43';
const TAB_B = '1a2b3c4d-5e6f-5071-9b8c-1d2e3f4a5b6c';
const TAB_SHELL = '3c4d5e6f-7a8b-5c9d-8e0f-1a2b3c4d5e6f';
const TAB_CHAT = '4d5e6f7a-8b9c-5d0e-9f1a-2b3c4d5e6f7a';

// A terminal tab states the terminal mode. An unstated one shows vibe, and the panel would switch
// the PTY agent to chat on mount — staging `pty_mode: false` (headless, never given back) until the
// switch request settles, which on a slow runner is after the assertion.
const terminalMode = { [VIEW_MODE_PARAM]: ViewMode.Advanced };
const dockA = new DockPointer(ViewType.SHELL, `agentic_process-${PROC_A}`, terminalMode);
const dockB = new DockPointer(ViewType.SHELL, `agentic_process-${PROC_B}`, terminalMode);
const dockChat = new DockPointer(ViewType.SHELL, `agentic_process-${PROC_CHAT}`);
const dockShell = new DockPointer(ViewType.SHELL, `shell-${PLAIN_SHELL}`);
const assetDock = DockPointer.fromUrl(
  `/dock/project/${PROJECT_ID}/editor/markdown/typeid/markdown-f745759c-9113-4057-a82f-883e472e2933`,
);
let currentDock: DockPointer = dockA;

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

const ShellLayout = () => (
  <div data-testid="shell-layout" style={{ height: 600 }}>
    <TabbedTerminal className="h-full" scope="all" spawnProjectId={PROJECT_ID} />
  </div>
);
const AssetLayout = () => <div data-testid="asset-layout">markdown editor</div>;
const App = ({ children }: PropsWithChildren) => (
  <QueryClientProvider client={queryClient}>
    {children}
    <TerminalPool />
  </QueryClientProvider>
);
const layoutFor = (dock: DockPointer) => (dock.viewType === ViewType.SHELL ? <ShellLayout /> : <AssetLayout />);

function mkAgent(procId: string, shellId: string | null, extra: object = {}): void {
  new AgenticProcess({
    id: procId,
    shell_id: shellId,
    project_id: PROJECT_ID,
    status: 'running',
    visible: true,
    pty_mode: true,
    ...extra,
  } as never);
  if (shellId) new Shell({ id: shellId, project_id: PROJECT_ID } as never);
}

function mkTab(tabId: string, dock: DockPointer, targetType: string, targetId: string, lastActive: number): Tab {
  return new Tab({
    id: tabId,
    pointer: dock.toJSON(),
    target_type: targetType,
    target_id: targetId,
    project_id: PROJECT_ID,
    last_active_at: lastActive,
    visible: true,
  } as never);
}

/** The backend's save after the worker exited, as the store applies the WS op. */
const deliverStatus = (procId: string, status: ProcessStatus) =>
  act(() => {
    (dataManager as unknown as { onDataOp(t: string, op: string, d: object): void }).onDataOp(
      `agentic_process-${procId}`,
      'update',
      { type: AgenticProcess.type, id: procId, status },
    );
  });

let start: ReturnType<typeof vi.spyOn>;
let tabs: Tab[];

beforeEach(() => {
  currentDock = dockA;
  mkAgent(PROC_A, SHELL_A);
  mkAgent(PROC_B, SHELL_B);
  mkAgent(PROC_CHAT, null, { pty_mode: false, status: 'stopped' });
  new Shell({ id: PLAIN_SHELL, project_id: PROJECT_ID } as never);
  tabs = [
    mkTab(TAB_A, dockA, 'agentic_process', PROC_A, 5_000),
    mkTab(TAB_B, dockB, 'agentic_process', PROC_B, 4_000),
    mkTab(TAB_SHELL, dockShell, 'shell', PLAIN_SHELL, 3_000),
    mkTab(TAB_CHAT, dockChat, 'agentic_process', PROC_CHAT, 2_000),
  ];
  tabManager.adoptGlobal(tabs);
  vi.spyOn(connectionManager, 'waitForConnected').mockResolvedValue(undefined as never);
  start = vi.spyOn(AgenticProcess.prototype, 'start').mockResolvedValue(true as never);
  vi.spyOn(Shell.prototype, 'ensureStarted').mockResolvedValue(undefined as never);
});

afterEach(() => {
  cleanup();
  tabManager.resetForTests();
  terminalPool.resetForTests();
  vi.restoreAllMocks();
});

async function mount() {
  const view = render(<App>{layoutFor(currentDock)}</App>);
  const settle = async () => {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  };
  const goTo = async (dock: DockPointer) => {
    currentDock = dock;
    view.rerender(<App>{layoutFor(currentDock)}</App>);
    await settle();
  };
  await settle();
  const panel = (pointer: string) => document.querySelector(`[data-session-id="${pointer}"]`);
  const agent = (proc: string) => panel(`agentic_process-${proc}`);
  return { view, goTo, settle, panel, agent };
}

/** The tab is still open: the store still answers for its key. */
const tabIsOpen = (dock: DockPointer) => tabManager.findByDockKey(dock.tabHash) !== null;

describe('an ended agent behind another tab', () => {
  it('loses its panel the moment its process ends, and keeps its tab', async () => {
    const t = await mount();
    await t.goTo(dockB);
    await t.goTo(dockA);
    const nodeA = t.agent(PROC_A);
    expect(t.agent(PROC_B), 'B was never mounted — nothing to give back').not.toBeNull();

    deliverStatus(PROC_B, ProcessStatus.STOPPED);
    await t.settle();

    expect(t.agent(PROC_B), 'an ended agent stayed mounted behind another tab').toBeNull();
    expect(terminalPool.has(dockB.tabHash)).toBe(false);
    expect(document.querySelector(`[data-terminal-key="${dockB.tabHash}"]`), 'its container stayed').toBeNull();
    expect(tabIsOpen(dockB), 'the tab itself was closed').toBe(true);
    expect(t.agent(PROC_A), 'the shown panel was rebuilt').toBe(nodeA);
    expect(t.agent(PROC_A)!.getAttribute('data-active')).toBe('true');
  });

  it('is given back for a failed process as for a stopped one', async () => {
    const t = await mount();
    await t.goTo(dockB);
    await t.goTo(dockA);

    deliverStatus(PROC_B, ProcessStatus.FAILED);
    await t.settle();

    expect(t.agent(PROC_B)).toBeNull();
  });
});

describe('an agent that ends while its tab is shown', () => {
  it('keeps its panel on screen, loses it when the user leaves, and starts again on return', async () => {
    const t = await mount();
    const nodeA = t.agent(PROC_A);
    const startsBefore = start.mock.calls.length;

    deliverStatus(PROC_A, ProcessStatus.STOPPED);
    await t.settle();
    expect(t.agent(PROC_A), 'the panel on screen was taken away').toBe(nodeA);
    expect(terminalPool.has(dockA.tabHash)).toBe(true);

    await t.goTo(dockB);
    expect(t.agent(PROC_A), 'an ended agent stayed mounted after the user left its tab').toBeNull();
    expect(tabIsOpen(dockA)).toBe(true);
    expect(t.agent(PROC_B)!.getAttribute('data-active')).toBe('true');

    await t.goTo(dockA);
    expect(t.agent(PROC_A), 'the tab did not come back').not.toBeNull();
    expect(t.agent(PROC_A), 'the return reused a panel that should have been gone').not.toBe(nodeA);
    expect(t.agent(PROC_A)!.getAttribute('data-active')).toBe('true');
    // The cold mount starts the agent again — the panel's own start, not a click handler's.
    expect(start.mock.calls.length, 'the returning panel did not start its agent').toBe(startsBefore + 2);
  });

  it('is given back when the user leaves for a place with no terminal at all', async () => {
    const t = await mount();
    deliverStatus(PROC_A, ProcessStatus.STOPPED);

    await t.goTo(assetDock);

    expect(t.agent(PROC_A)).toBeNull();
    expect(tabIsOpen(dockA)).toBe(true);
  });
});

describe('what the pool never gives back', () => {
  it('keeps a running agent, a plain shell and a headless chat mounted behind another tab', async () => {
    const t = await mount();
    for (const dock of [dockB, dockShell, dockChat, dockA]) await t.goTo(dock);
    const kept = {
      running: t.agent(PROC_B),
      shell: t.panel(`shell-${PLAIN_SHELL}`),
      chat: t.agent(PROC_CHAT),
    };
    expect(kept.running && kept.shell && kept.chat, 'a panel never mounted').toBeTruthy();

    // Another agent ending is no reason to touch these three.
    deliverStatus(PROC_A, ProcessStatus.STOPPED);
    await t.goTo(dockB);
    await t.goTo(assetDock);

    expect(t.agent(PROC_A), 'the ended agent is the one that goes').toBeNull();
    expect(t.agent(PROC_B), 'a running agent was unmounted').toBe(kept.running);
    expect(t.panel(`shell-${PLAIN_SHELL}`), 'a plain shell was unmounted').toBe(kept.shell);
    expect(t.agent(PROC_CHAT), 'a stopped headless chat was unmounted').toBe(kept.chat);
  });

  it('refuses to release a key a slot is showing', async () => {
    await mount();

    expect(terminalPool.release(dockA.tabHash)).toBe(false);
    expect(terminalPool.has(dockA.tabHash)).toBe(true);
  });
});
