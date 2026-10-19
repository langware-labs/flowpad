import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { TooltipProvider } from '@src/components/ui/tooltip';
import { ContentPanel } from '@src/pages/flow-page/content-panel/content-panel';
import { afterEach, expect, it, vi } from 'vitest';

/**
 * Regression: a plain HTML file shown in the agent's display
 * (`…/display/editor/html/vfs/…?activeDisplay=1`) was wrapped in the project
 * setup gate, so a project with an unfinished setup step ("waiting on Google
 * Cloud") hid a file that needs nothing set up. Only an app waits on setup.
 *
 * Real chain: router → ContentPanel → (gate decision) → ProjectLoadGate.
 */

vi.mock('@src/pages/flow-page/content-panel/unified-tab-strip', () => ({ UnifiedTabStrip: () => null }));
vi.mock('@src/pages/flow-page/content-panel/user-dropdown/user-dropdown', () => ({ UserDropdown: () => null }));
vi.mock('@src/navigation/NavigatorSlot', () => ({ NavigatorSlot: () => null }));
vi.mock('@src/components/terminal', () => ({ TabbedTerminal: () => null }));
vi.mock('@src/components/code-editor/CodeEditor', () => ({ default: () => null }));
vi.mock('@src/components/code-editor/DiffViewer', () => ({ default: () => null }));

const { PROJECT_ID } = vi.hoisted(() => ({ PROJECT_ID: '07dd5d2e-aeda-41fa-b288-39f98b3b6818' }));
vi.mock('@src/components/agent-layout/agent-layout', () => ({
  useAgentContext: () => ({ flow: null, agent: null, project: { id: PROJECT_ID }, computeNode: null }),
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
vi.mock('@src/hooks/useFS', () => ({ useFS: () => null }));

afterEach(cleanup);

const FILE_URL =
  `/dock/project/${PROJECT_ID}/process/agentic_process-489d078f-df96-4b01-a3e5-fddcc4279519` +
  '/display/editor/html/vfs/compute_node-%40local/Users/me/proj/docs/nudge_backoffice_mock.html' +
  '?viewMode=vibe&activeDisplay=1';

it('a static HTML file in the active display opens without waiting on project setup', async () => {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TooltipProvider>
        <MemoryRouter initialEntries={[FILE_URL]}>
          <Routes>
            <Route path="dock/:viewType/*" element={<ContentPanel />} />
          </Routes>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );

  // The file's own viewer mounts …
  expect(await screen.findByText('Loading preview…')).toBeInTheDocument();
  // … and no setup gate stands in front of it.
  expect(screen.queryByTestId('project-load-gate')).not.toBeInTheDocument();
});
