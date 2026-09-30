/**
 * A tab switch moves nothing in the DOM (FLOWPAD-2193).
 *
 * Reported on prod 0.2.179: leaving the tab of a long chat ("wizard", a 42 MB
 * transcript, ~30k nodes) froze the UI for 7–15 s. Since 0.2.178 the pool moved
 * each panel on every switch — the one left into a 0×0 parking element, the one
 * chosen into the slot. Moving a node throws its layout away, and a chat laid
 * out at zero width wraps every character onto its own line (11M px tall).
 * Proven on a prod-data clone and on dev: a full-size parking cut the freeze to
 * ~0.6 s; not moving at all is what v0.2.177 did (0.1–0.25 s).
 *
 * So the pool keeps every panel in ONE stack that sits in the slot, and a switch
 * only flips which panel is visible. Only a change of SLOT (another layout, or
 * none) moves the stack — once, whole.
 *
 * OBSERVATION POINT — DOM mutations that add or remove a pool container or the
 * stack, recorded by a MutationObserver over the whole document. A move is
 * exactly a remove + add, so counting them IS the move being detected. The real
 * `TabbedTerminal`, `TerminalPool` and `InteractiveTerminal` run; dock navigation
 * and agent context are the only mocks, as in terminal_tab_switch_keeps_xterm_mounted.
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
const TAB_A = '6fe6a58f-10ce-5e41-ae3e-8676067d9b43';
const TAB_B = '1a2b3c4d-5e6f-5071-9b8c-1d2e3f4a5b6c';

const dockA = new DockPointer(ViewType.SHELL, `agentic_process-${PROC_A}`);
const dockB = new DockPointer(ViewType.SHELL, `agentic_process-${PROC_B}`);
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
    <TabbedTerminal className="h-full" spawnProjectId={PROJECT_ID} />
  </div>
);
/** Another layout component in the same place, with no terminal in it. */
const AssetLayout = () => <div data-testid="asset-layout">markdown editor</div>;
const App = ({ children }: PropsWithChildren) => (
  <QueryClientProvider client={queryClient}>
    {children}
    <TerminalPool />
  </QueryClientProvider>
);
const layoutFor = (dock: DockPointer) => (dock.viewType === ViewType.SHELL ? <ShellLayout /> : <AssetLayout />);

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
  tabManager.adoptGlobal([mkTab(TAB_A, dockA, PROC_A, 5_000), mkTab(TAB_B, dockB, PROC_B, 4_000)]);
  vi.spyOn(connectionManager, 'waitForConnected').mockResolvedValue(undefined as never);
  vi.spyOn(AgenticProcess.prototype, 'start').mockResolvedValue(true as never);
});

afterEach(() => {
  cleanup();
  tabManager.resetForTests();
  terminalPool.resetForTests();
  vi.restoreAllMocks();
});

/** A pool container or the stack itself — the nodes whose moves re-lay-out a panel. */
const isPoolNode = (n: Node) =>
  n instanceof HTMLElement && (n.dataset.terminalKey !== undefined || n.dataset.testid === 'terminal-pool-stack');

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
  const moves: string[] = [];
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      for (const n of [...r.addedNodes, ...r.removedNodes]) {
        if (isPoolNode(n)) moves.push((n as HTMLElement).dataset.terminalKey ?? 'stack');
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  const drain = () => {
    for (const r of observer.takeRecords()) {
      for (const n of [...r.addedNodes, ...r.removedNodes]) {
        if (isPoolNode(n)) moves.push((n as HTMLElement).dataset.terminalKey ?? 'stack');
      }
    }
    return moves.splice(0);
  };
  const panel = (proc: string) =>
    view.container.ownerDocument.querySelector(`[data-session-id="agentic_process-${proc}"]`);
  const stack = () => document.querySelector('[data-testid="terminal-pool-stack"]');
  return { view, goTo, drain, panel, stack, disconnect: () => observer.disconnect() };
}

describe('the terminal pool on a tab switch', () => {
  it('moves no panel and no stack while switching tabs in the same layout', async () => {
    const t = await mount();
    await t.goTo(dockB); // B's first visit mounts its panel: that is a creation, not a move
    t.drain();

    for (const dock of [dockA, dockB, dockA, dockB, dockA]) await t.goTo(dock);

    expect(t.drain(), 'a warm tab switch moved pool nodes — every move re-lays-out a whole panel').toEqual([]);
    expect(t.panel(PROC_A)!.getAttribute('data-active')).toBe('true');
    expect(t.panel(PROC_B)!.getAttribute('data-active')).toBe('false');
    expect(t.view.getByTestId('shell-layout').contains(t.stack()), 'the stack is not in the shown slot').toBe(true);
    t.disconnect();
  });

  it('moves the stack whole — never a single panel — when the layout changes, and keeps both panels in it', async () => {
    const t = await mount();
    await t.goTo(dockB);
    t.drain();

    await t.goTo(assetDock);
    const parking = document.querySelector('[data-testid="terminal-pool-parking"]')!;
    expect(parking.contains(t.stack()), 'with no slot on screen the stack is not parked').toBe(true);
    await t.goTo(dockA);

    expect(
      t.drain().filter((m) => m !== 'stack'),
      'a layout change moved single panels out of the stack',
    ).toEqual([]);
    expect(t.view.getByTestId('shell-layout').contains(t.stack())).toBe(true);
    expect(t.stack()!.contains(t.panel(PROC_A)) && t.stack()!.contains(t.panel(PROC_B))).toBe(true);
    t.disconnect();
  });

  it('parks at full size, never 0×0', async () => {
    await mount();
    const parking = document.querySelector<HTMLElement>('[data-testid="terminal-pool-parking"]')!;
    // A panel parked at zero width is re-laid-out a character per line: seconds
    // for a long chat, paid every time its tab was left (the FLOWPAD-2193 freeze).
    expect(parking.style.width, 'parking has a width of its own').not.toBe('0px');
    expect(parking.style.height, 'parking has a height of its own').not.toBe('0px');
    expect(parking.style.inset, 'parking does not fill the viewport').toMatch(/^0(px)?$/);
    expect(parking.style.position).toBe('fixed');
    expect(parking.hasAttribute('inert'), 'parked panels could take focus or clicks').toBe(true);
  });
});
