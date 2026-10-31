/** `AppLifecyclePanel`: one switch over the record's state — each state's screen, and only one Fix it. */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { Project, type WebAppLifecycle } from '@sdk';
import type { AppLifecycle } from '@src/components/webapp-display/useAppLifecycle';

vi.mock('@src/components/ask/AskForm', () => ({
  AskForm: ({ questionId }: { questionId: string }) => <p data-testid="ask-form">{questionId}</p>,
}));
vi.mock('@src/components/project-setup/SetupTreeView', () => ({
  SetupTreeView: ({ tree }: { tree: unknown }) => (tree ? <p data-testid="setup-tree" /> : null),
}));

const { AppLifecyclePanel } = await import('@src/components/webapp-display/AppLifecyclePanel');

const ID = '11111111-1111-4111-8111-111111111111';
const P = '22222222-2222-4222-8222-222222222222';
const rec = (state: WebAppLifecycle['state'], extra: Partial<WebAppLifecycle> = {}) =>
  ({ webapp_id: ID, project_id: P, state, detail: '', recovery: '', ports: {}, pids: {}, failure: null, attempts: [], agent_call: '', setup_owed: '', ...extra }) as WebAppLifecycle;

function lifecycleOf(record: WebAppLifecycle | null, extra: Partial<AppLifecycle> = {}): AppLifecycle {
  return {
    app: null,
    record,
    loading: false,
    notFound: false,
    showable: record?.state === 'up' || record?.state === 'degraded',
    questionId: null,
    settleQuestion: () => {},
    fixIt: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    reportPage: async () => null,
    ...extra,
  };
}

const show = (lifecycle: AppLifecycle) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AppLifecyclePanel lifecycle={lifecycle} />
    </QueryClientProvider>,
  );

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('no record yet, or down: checking', () => {
  show(lifecycleOf(null));
  expect(screen.getByTestId('app-lifecycle-panel')).toHaveAttribute('data-state', 'checking');
  cleanup();
  show(lifecycleOf(rec('down')));
  expect(screen.getByTestId('app-lifecycle-panel')).toHaveAttribute('data-state', 'checking');
});

it('up draws nothing', () => {
  const { container } = show(lifecycleOf(rec('up')));
  expect(container).toBeEmptyDOMElement();
});

it('degraded is a thin banner, never a screen', () => {
  show(lifecycleOf(rec('degraded', { failure: { phase: 'page', code: 'console_error', source: 'console', text: 'favicon 404', fingerprint: 'f' } })));
  expect(screen.getByTestId('app-lifecycle-degraded')).toHaveTextContent('Up, with problems: favicon 404');
  expect(screen.queryByTestId('app-lifecycle-panel')).not.toBeInTheDocument();
});

it.each(['installing', 'building', 'starting'] as const)('%s: setting up, with the setup tree', async (state) => {
  const read = vi.spyOn(Project, 'setupRun').mockResolvedValue({ run: 'r', running: true, tree: { root: {} } } as never);
  show(lifecycleOf(rec(state, { detail: 'npm install' })));
  expect(screen.getByTestId('app-lifecycle-panel')).toHaveAttribute('data-state', state);
  expect(screen.getByText('Setting up — npm install')).toBeInTheDocument();
  expect(await screen.findByTestId('setup-tree')).toBeInTheDocument();
  expect(read).toHaveBeenCalledWith(P, `micro_app-${ID}`);
  expect(screen.queryByRole('button', { name: 'Fix it' })).not.toBeInTheDocument();
});

it("recovering: says what is being done, and draws the fixer's question in place", () => {
  show(
    lifecycleOf(rec('recovering', { recovery: 'an agent repairs the app', agent_call: 'compute_op-x/c1' }), {
      questionId: 'q-1',
    }),
  );
  expect(screen.getByText('Recovering: an agent repairs the app')).toBeInTheDocument();
  expect(screen.getByText('An agent is repairing the app')).toBeInTheDocument();
  expect(screen.getByTestId('ask-form')).toHaveTextContent('q-1');
  expect(screen.queryByRole('button', { name: 'Fix it' })).not.toBeInTheDocument();
});

it.each(['needs_person', 'failed'] as const)('%s: needs you, with ONE Fix it and Cancel', (state) => {
  const lifecycle = lifecycleOf(
    rec(state, { failure: { phase: 'start', code: 'port_held', source: 'step', text: 'port 4400 is held', fingerprint: 'f' } }),
  );
  show(lifecycle);
  expect(screen.getByText('Needs you: port 4400 is held')).toBeInTheDocument();
  expect(screen.getAllByRole('button', { name: 'Fix it' })).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Fix it' }));
  expect(lifecycle.fixIt).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(lifecycle.stop).toHaveBeenCalledTimes(1);
});
