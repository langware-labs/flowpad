import '@testing-library/jest-dom/vitest';
import { act, cleanup, render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { TooltipProvider } from '@src/components/ui/tooltip';
import { ContentPanel } from '@src/pages/flow-page/content-panel/content-panel';
import { afterEach, expect, it, vi } from 'vitest';

/**
 * Regression: in vibe mode, an HTML page in the display did not show the agent's edit ("make the
 * button blue") until a browser refresh. The page's frame is parked by the iframe registry (one per
 * page per session, so a session switch does not reload it); the vibe host's only "something changed"
 * signal is its content epoch (`ContentPanel`'s `contentEpoch`, bumped when an agent turn wrote), which
 * REMOUNTS the body — and a remount hands the parked document back unchanged. Apps reload their frame
 * on a new epoch; the page did not.
 *
 * Real chain: router → ContentPanel(contentEpoch) → HtmlPreview → PersistentIframe → the frame the
 * registry parks. The assertion is on the frame's navigation (a proxy for "the user sees the edit").
 */

vi.mock('@src/pages/flow-page/content-panel/unified-tab-strip', () => ({ UnifiedTabStrip: () => null }));
vi.mock('@src/pages/flow-page/content-panel/user-dropdown/user-dropdown', () => ({ UserDropdown: () => null }));
vi.mock('@src/navigation/NavigatorSlot', () => ({ NavigatorSlot: () => null }));
vi.mock('@src/components/terminal', () => ({ TabbedTerminal: () => null }));
vi.mock('@src/components/code-editor/CodeEditor', () => ({ default: () => null }));
vi.mock('@src/components/code-editor/DiffViewer', () => ({ default: () => null }));

const { PROJECT_ID, PROCESS_ID } = vi.hoisted(() => ({
  PROJECT_ID: '07dd5d2e-aeda-41fa-b288-39f98b3b6818',
  PROCESS_ID: '489d078f-df96-4b01-a3e5-fddcc4279519',
}));
vi.mock('@src/components/agent-layout/agent-layout', () => ({
  useAgentContext: () => ({
    flow: null,
    flowId: PROCESS_ID,
    agent: null,
    project: { id: PROJECT_ID },
    computeNode: { typeId: { type: 'compute_node', id: '@local', toString: () => 'compute_node-@local' } },
  }),
}));
vi.mock('@sdk/react/hooks', async (orig) => ({
  ...(await orig<typeof import('@sdk/react/hooks')>()),
  useAuth: () => ({ user: { id: 'user-1' } }),
  useContext: () => ({ project: null }),
}));
vi.mock('@src/hooks/flow-hooks', async (orig) => ({
  ...(await orig<typeof import('@src/hooks/flow-hooks')>()),
  useActiveViewer: () => {},
}));
vi.mock('@src/tabs/use-tab-manager', async (orig) => ({
  ...(await orig<typeof import('@src/tabs/use-tab-manager')>()),
  useTerminalTabs: () => [],
  useTabLifecycle: () => undefined,
}));

// This test's own frame, by its url: other files leave frames of their own in the shared document.
const pageFrames = () => [...document.querySelectorAll<HTMLIFrameElement>('iframe[src*="/proj/rca.html"]')];

afterEach(() => {
  cleanup();
  // The iframe registry parks its frames in the document body, outside the React tree, so
  // `cleanup` leaves them: take ours out so no other test sees a second `html-preview` frame.
  pageFrames().forEach((frame) => frame.parentElement?.parentElement?.remove());
});

const FILE_URL =
  `/dock/project/${PROJECT_ID}/process/agentic_process-${PROCESS_ID}` +
  '/display/editor/html/vfs/compute_node-%40local/Users/me/proj/rca.html?viewMode=vibe';

function panel(epoch: number) {
  return (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TooltipProvider>
        <MemoryRouter initialEntries={[FILE_URL]}>
          <Routes>
            <Route path="dock/:viewType/*" element={<ContentPanel minimalChrome contentEpoch={epoch} />} />
          </Routes>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

it("reloads the shown HTML page's frame when the host's content epoch advances (an agent turn wrote)", async () => {
  const view = render(panel(0));
  await act(async () => {});
  const [frame] = pageFrames();
  expect(frame).toBeDefined();
  const navigations = vi.spyOn(frame, 'src', 'set');

  // The agent's turn ended after writing: the host re-keys its body with a new epoch.
  view.rerender(panel(1));
  await act(async () => {});

  // The registry parks the page's frame, so the same document comes back — it must be navigated
  // again to show the edit.
  expect(pageFrames()).toEqual([frame]);
  expect(navigations).toHaveBeenCalledTimes(1);
});
