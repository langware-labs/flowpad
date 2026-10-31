/**
 * The display forwards EVERY report its own frame's reporter posts — settled or not — with the served
 * document's `load_id` verbatim; a report from any other window is ignored. Recovery is the backend's.
 */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ServedApp, WebAppLifecycle } from '@sdk';
import { PAGE_REPORT, WebappDisplay } from '@src/components/webapp-display/WebappDisplay';
import type { AppLifecycle } from '@src/components/webapp-display/useAppLifecycle';

const SRC = 'about:blank#reporter-app';
const endpoint = { id: 'ep-1' } as unknown as ServedApp;

function lifecycleOf(state: WebAppLifecycle['state']): AppLifecycle {
  return {
    app: null,
    record: { state } as WebAppLifecycle,
    loading: false,
    notFound: false,
    showable: state === 'up' || state === 'degraded',
    questionId: null,
    settleQuestion: () => {},
    fixIt: async () => {},
    stop: async () => {},
    reportPage: vi.fn(async () => null),
  };
}

afterEach(cleanup);

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const wrap = (node: ReactNode) => <QueryClientProvider client={client}>{node}</QueryClientProvider>;

const frame = () => document.querySelector<HTMLIFrameElement>(`iframe[src="${SRC}"]`)!;
const post = (data: unknown, source: unknown) =>
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data, source: source as Window }));
  });

it('forwards every report of its own frame with its load_id, settled or not', () => {
  const lifecycle = lifecycleOf('up');
  render(<WebappDisplay endpoint={endpoint} src={SRC} lifecycle={lifecycle} />);
  const guest = frame().contentWindow;
  const errors = [{ source: 'page', text: 'TypeError: x is undefined' }];
  post({ type: PAGE_REPORT, errors, settled: false, load_id: 'load-1' }, guest);
  post({ type: PAGE_REPORT, errors, settled: true, load_id: 'load-1' }, guest);
  expect(lifecycle.reportPage).toHaveBeenNthCalledWith(1, endpoint, errors, false, 'load-1');
  expect(lifecycle.reportPage).toHaveBeenNthCalledWith(2, endpoint, errors, true, 'load-1');
});

it('ignores a report from any other window', () => {
  const lifecycle = lifecycleOf('up');
  render(<WebappDisplay endpoint={endpoint} src={SRC} lifecycle={lifecycle} />);
  post({ type: PAGE_REPORT, errors: [], settled: true, load_id: 'load-1' }, window);
  post({ type: PAGE_REPORT, errors: [], settled: true, load_id: 'load-1' }, null);
  expect(lifecycle.reportPage).not.toHaveBeenCalled();
});

it('the frame is shown iff the record is showable; degraded keeps it under a banner', () => {
  const view = render(wrap(<WebappDisplay endpoint={endpoint} src={SRC} lifecycle={lifecycleOf('starting')} />));
  expect(screen.queryByTestId('webapp-display')).not.toBeInTheDocument();
  expect(screen.getByTestId('app-lifecycle-panel')).toBeInTheDocument();
  view.rerender(wrap(<WebappDisplay endpoint={endpoint} src={SRC} lifecycle={lifecycleOf('degraded')} />));
  expect(screen.getByTestId('webapp-display')).toBeInTheDocument();
  expect(screen.getByTestId('app-lifecycle-degraded')).toBeInTheDocument();
});
