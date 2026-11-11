/**
 * A page served as plain files (`flow app serve`, a static endpoint) opens in its project's tab
 * without waiting on that project's setup: its files can live anywhere (a mock in $TMPDIR) and
 * need nothing set up. Reported: a mock showed "flowpad-oss: waiting on Slack sign-in, github-pat,
 * Gmail · Set up" instead of its HTML. An app with a server of its own is shown only when its lifecycle
 * record is showable.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';

const ARTIFACT = 'bab4e8e7-3a81-48ca-bc5f-1eb0b1e5ad8f';
const projectId = '2a1e40da-9221-4ea4-82f3-18a0928a4654';

const display = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock('@src/hooks/flow-hooks', () => ({
  hostBrand: () => ({ primary: '', primaryInk: '' }),
  useAppDisplay: () => display.current,
}));
vi.mock('@sdk/react/hooks', () => ({
  useEntity: () => ({ data: { project_id: projectId }, notFound: false }),
}));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ currentDock: null, navigation: { openDock: vi.fn() } }),
}));
vi.mock('@src/hooks/useContext', () => ({ useContext: () => ({ project: { id: projectId } }) }));
const lifecycle = vi.hoisted(() => ({
  of: (id: string | null) =>
    ({
      app: null, record: id ? { state: 'down' } : null, loading: false, notFound: false,
      showable: false, questionId: null,
      settleQuestion: () => {}, fixIt: async () => {}, stop: async () => {}, reportPage: async () => null,
    }) as unknown,
}));
vi.mock('@src/components/webapp-display/useAppLifecycle', () => ({ useAppLifecycle: (id: string | null) => lifecycle.of(id) }));
vi.mock('@src/components/display-toolbar', () => ({ WebappDisplayToolbar: () => null }));

const { AppDisplayViewer } = await import('@src/pages/flow-page/app-display-viewer');

afterEach(cleanup);

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const open = (backend: Record<string, unknown>) => {
  display.current = {
    loading: false,
    theme: 'light',
    view: 'desk',
    src: 'about:blank#mock',
    runtime: 'served',
    available: ['served'],
    idleDev: null,
    endpoint: { id: 'ep-1', project_id: projectId, webapp_id: 'cf255aa4-1156-45d2-bfa0-3767d01a2e25', backend },
  };
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AppDisplayViewer artifactId={ARTIFACT} runtime={null} options={{}} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

it('a page served as static files opens at once, whatever its record says', () => {
  open({ type: 'static', root: '/tmp/mockify/x/mock-message-landing' });
  expect(screen.queryByTestId('app-lifecycle-panel')).not.toBeInTheDocument();
  expect(screen.getByTestId('webapp-display')).toBeInTheDocument();
});

it('an app behind its own server waits on its lifecycle record', () => {
  open({ type: 'proxy', port: 5173 });
  expect(screen.getByTestId('app-lifecycle-panel')).toBeInTheDocument();
  expect(screen.queryByTestId('webapp-display')).not.toBeInTheDocument();
});
