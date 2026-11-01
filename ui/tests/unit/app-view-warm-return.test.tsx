/**
 * Coming back to an app that is up asks the backend for NOTHING (docs/navigation/dock-loading.md, I4): the
 * record rides on the cached `WebApp` row and is kept live by its push, so a return — even one that mounts
 * the view again — neither reads the record, nor asks the app to come up, nor validates a load.
 */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { recordRequests } from '../utils/dock-loader-harness';

const APP = '5c5c5c5c-5c5c-4c5c-8c5c-5c5c5c5c5c5c';
const SRC = 'http://localhost:49651/sales/';

vi.mock('@src/hooks/flow-hooks', async (orig) => ({
  ...(await orig<typeof import('@src/hooks/flow-hooks')>()),
  useAppDisplay: () => ({
    loading: false,
    theme: 'light',
    view: 'desk',
    src: SRC,
    runtime: 'dev',
    available: ['dev'],
    idleDev: null,
    endpoint: { id: 'ep', project_id: null, webapp_id: APP, backend: { type: 'proxy', port: 49651 }, pageReport: vi.fn() },
  }),
}));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ currentDock: null, navigation: { openDock: vi.fn() } }),
  useCurrentDock: () => null,
}));
vi.mock('@src/hooks/useContext', () => ({ useContext: () => ({ project: null }) }));

const { WebApp } = await import('@sdk');
const { AppDisplayViewer } = await import('@src/pages/flow-page/app-display-viewer');

beforeEach(() => {
  new WebApp({
    id: APP,
    name: 'sales',
    lifecycle: { webapp_id: APP, state: 'up' },
  } as never).markAsExpanded();
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const view = () => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter>
      <AppDisplayViewer artifactId={null} microAppId={APP} />
    </MemoryRouter>
  </QueryClientProvider>
);

it('a return to an app that is up makes no api request, and shows the frame at once', async () => {
  const first = render(view());
  await act(async () => {});
  expect(screen.getByTestId('webapp-display')).toBeInTheDocument();
  first.unmount();

  const log = recordRequests();
  render(view());
  expect(screen.getByTestId('webapp-display')).toBeInTheDocument();
  await act(async () => {});
  expect(log.map((r) => `${r.method} ${r.path}`)).toEqual([]);
});
