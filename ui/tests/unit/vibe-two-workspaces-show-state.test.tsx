/**
 * Two Vibe tabs, one workspace component. Switching Vibe tab A → B re-renders the
 * SAME `VibeWorkspace` with B's session, so per-workspace show state must follow
 * the session:
 *   - A's last show must not leak into B's display-history popover;
 *   - B's first show must PUSH (keep the URL the user arrived on for Back), even
 *     though A already pushed one.
 * Mocks are ambient only (agent context, navigation as the observation point, the
 * chat pane, the display body), as in vibe_display_open_in_tab.test.tsx.
 */
import { type PropsWithChildren } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgenticProcess } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';

const PROJECT_ID = 'f20cecb9-72e7-4cd4-92f2-61b5c48b45cf';
const A = '853880a0-dd7b-4872-9db2-3bc2b97390dd';
const B = '1d7c0a52-6a5e-4f0e-9b39-2f6a8f1c0b11';
const DOC_A = '/w/p/from-a.md';
const DOC_B = '/w/p/from-b.md';

const openDock = vi.fn();
const replaceDock = vi.fn();
const dockOf = (id: string) => new DockPointer(ViewType.VIBE, `agentic_process-${id}`);
let currentDock = dockOf(A);
const listeners = new Map<string, (t: Record<string, unknown>) => void>();
const processes = new Map<string, AgenticProcess>();
for (const id of [A, B]) {
  const p = new AgenticProcess({ id });
  vi.spyOn(p, 'on').mockImplementation((event, listener) => {
    if (event === 'show') listeners.set(id, listener as (t: Record<string, unknown>) => void);
    return () => {};
  });
  processes.set(id, p);
}

vi.mock('@src/contexts/agent-context', () => ({
  useAgentContext: () => ({ project: { id: PROJECT_ID } }),
}));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ currentDock, navigation: { openDock, replaceDock } }),
  useCurrentDock: () => currentDock,
}));
vi.mock('@src/pages/flow-page/vibe-chat-pane', () => ({
  VibeChatPane: () => <div data-testid="vibe-chat-pane" />,
}));
vi.mock('@src/pages/flow-page/content-panel/content-panel', () => ({
  ContentPanel: () => <div data-testid="content-panel" />,
}));
vi.mock('@src/pages/flow-page/use-vibe-workspace-session', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useVibeWorkspaceSessionHost: (session: { processId: string }) => processes.get(session.processId) ?? null,
}));

import { VibeWorkspace } from '@src/pages/flow-page/vibe-workspace';
import { TooltipProvider } from '@src/components/ui/tooltip';

const queryClient = new QueryClient();
const Wrap = ({ children }: PropsWithChildren) => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>{children}</TooltipProvider>
  </QueryClientProvider>
);
const sessionOf = (id: string) => ({ processId: id, processDock: dockOf(id), processTab: null, onProcessUrl: true });

afterEach(() => {
  cleanup();
  openDock.mockReset();
  replaceDock.mockReset();
  listeners.clear();
  currentDock = dockOf(A);
});

describe('two Vibe tabs share one workspace component', () => {
  it("switching tabs resets the show state: no history leak, B's first show pushes", () => {
    processes.get(A)!.context_data = { display_stack: [{ kind: 'vfs', path: DOC_A, shown_at: 1 }] } as never;
    processes.get(B)!.context_data = { display_stack: [{ kind: 'vfs', path: DOC_B, shown_at: 1 }] } as never;

    const view = render(
      <Wrap>
        <VibeWorkspace session={sessionOf(A) as never} />
      </Wrap>,
    );
    act(() => listeners.get(A)?.({ kind: 'vfs', path: DOC_A }));
    expect(openDock).toHaveBeenCalledTimes(1); // A's first show pushed

    // Switch to Vibe tab B: same component, another session.
    currentDock = dockOf(B);
    view.rerender(
      <Wrap>
        <VibeWorkspace session={sessionOf(B) as never} />
      </Wrap>,
    );

    fireEvent.click(screen.getByTestId('display-history'));
    const rows = screen.getAllByTestId('display-history-row').map((r) => r.textContent ?? '');
    expect(rows.some((r) => r.includes('from-a.md'))).toBe(false);
    expect(rows.some((r) => r.includes('from-b.md'))).toBe(true);

    openDock.mockReset();
    act(() => listeners.get(B)?.({ kind: 'vfs', path: DOC_B }));
    expect(openDock).toHaveBeenCalledTimes(1);
    expect(replaceDock).not.toHaveBeenCalled();
  });
});
