import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { dataManager, Project, ServiceEndpoint, TypeId } from '@sdk';
import { TooltipProvider } from '@src/components/ui/tooltip';
import { validLoad, webappAsset } from '@src/components/project-setup/use-project-load';
import { ContentPanel } from '@src/pages/flow-page/content-panel/content-panel';
import { afterEach, expect, it, vi } from 'vitest';

/**
 * Regression: in vibe mode, returning to a session whose display shows an app flashed
 * "Checking what this needs…" before the app, even though this browser session had already
 * validated that app. The session opens its app by SERVICE ENDPOINT address
 * (`/dock/app/service_endpoint-…?route=…&host=…`); that address never resolved to the webapp
 * asset, so the gate got `asset=''` and skipped its held verdict.
 *
 * Real chain: router → ContentPanel → OwnerLoadGate → ProjectLoadGate.
 */

vi.mock('@src/pages/flow-page/content-panel/unified-tab-strip', () => ({ UnifiedTabStrip: () => null }));
vi.mock('@src/pages/flow-page/content-panel/user-dropdown/user-dropdown', () => ({ UserDropdown: () => null }));
vi.mock('@src/navigation/NavigatorSlot', () => ({ NavigatorSlot: () => null }));
vi.mock('@src/components/terminal', () => ({ TabbedTerminal: () => null }));

const { PROJECT_ID } = vi.hoisted(() => ({ PROJECT_ID: 'ebabdaae-5ac8-4216-a8eb-dbeb49607526' }));
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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const HOST = 'agentic_process-a21b22fc-f2a1-4889-adab-f60897781945';
const ENDPOINT_ID = '671e7350-2fe3-416f-b497-a1bfc494274a';
// The webapp the endpoint's `tasks-app` route serves (staging's row).
const WEBAPP_ID = '20b7145e-7610-5d16-a3b4-64d65b52d85e';
const APP_URL =
  `/dock/app/service_endpoint-${ENDPOINT_ID}` + `?runtime=dev&route=tasks-app&host=${HOST}&viewMode=vibe`;

it('returning to a vibe session shows its already-validated app without a load status', async () => {
  // Earlier in this browser session the app was opened: its endpoint row is cached and the app validated as up.
  dataManager.getRef(new TypeId(ServiceEndpoint.type, ENDPOINT_ID)).entity = new ServiceEndpoint({
    id: ENDPOINT_ID,
    name: 'app',
    project_id: PROJECT_ID,
    subkind: 'app',
    protocol: { spec_kind: 'web.app', entry: 'index.html' },
    backend: {
      type: 'routed',
      routes: { 'tasks-app': { backend: { type: 'proxy', port: 49650 }, webapp_id: WEBAPP_ID, artifact_id: null } },
    },
  } as never);
  validLoad.set(validLoad.key(PROJECT_ID, webappAsset(WEBAPP_ID), HOST), true);
  validLoad.set(validLoad.key(PROJECT_ID, '', HOST), true);
  // The backend check behind it never answers within the test: what is on screen is the first frames.
  vi.spyOn(Project, 'validateLoad').mockReturnValue(new Promise(() => {}));
  vi.spyOn(Project, 'load').mockReturnValue(new Promise(() => {}));
  vi.spyOn(Project, 'loadState').mockReturnValue(new Promise(() => {}));

  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TooltipProvider>
        <MemoryRouter initialEntries={[APP_URL]}>
          <Routes>
            <Route path="dock/:viewType/*" element={<ContentPanel />} />
          </Routes>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
  await act(async () => {});

  expect(screen.queryByText('Checking what this needs…')).not.toBeInTheDocument();
  expect(screen.queryByTestId('project-load-gate')).not.toBeInTheDocument();
});
