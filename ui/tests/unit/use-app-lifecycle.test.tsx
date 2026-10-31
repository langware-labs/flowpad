/**
 * `useAppLifecycle` reads THE record off the `WebApp` row (pushed, never polled), asks the backend to bring
 * an app up ONCE when it is neither showable nor busy, and draws the fixer's questions in place.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { WebAppLifecycle } from '@sdk';
import { deliverClaimedQuestion } from '@src/components/ask/ask-claims';

const ID = '11111111-1111-4111-8111-111111111111';
// Like the backend, every record a test makes changed state later than the one before (`since`).
let clock = Date.parse('2026-10-31T00:00:00Z');
const rec = (state: WebAppLifecycle['state'], extra: Partial<WebAppLifecycle> = {}) =>
  ({ webapp_id: ID, state, detail: '', recovery: '', since: new Date((clock += 1000)).toISOString(), ports: {}, pids: {},
     failure: null, attempts: [], agent_call: '', setup_owed: '', ...extra }) as WebAppLifecycle;

const h = vi.hoisted(() => ({
  app: null as null | Record<string, unknown>,
  watch: [] as unknown[],
}));
vi.mock('@sdk/react/hooks', () => ({
  useEntity: (_t: unknown, options: unknown) => {
    h.watch.push(options);
    return { data: h.app, isLoading: false, notFound: false };
  },
}));
vi.mock('@src/components/ask/ask-claims', async (orig) => ({
  ...(await orig<typeof import('@src/components/ask/ask-claims')>()),
  openQuestionOf: async () => null,
}));

const { useAppLifecycle } = await import('@src/components/webapp-display/useAppLifecycle');

function appWith(record: WebAppLifecycle | null) {
  const app = {
    lifecycle: record,
    up: vi.fn(async () => rec('starting')),
    fix: vi.fn(async () => rec('recovering', { recovery: 'restart' })),
    stop: vi.fn(async () => rec('down')),
  };
  h.app = app;
  return app;
}

afterEach(() => {
  h.app = null;
  h.watch = [];
});

it('watches the row: the record is live, no polling', () => {
  appWith(rec('up'));
  renderHook(() => useAppLifecycle(ID));
  expect(h.watch[0]).toEqual({ watch: true });
});

it('a down app is brought up once, and its answer is the record until the next push', async () => {
  const app = appWith(rec('down'));
  const { result, rerender } = renderHook(() => useAppLifecycle(ID, { display: 'proc-1' }));
  await waitFor(() => expect(result.current.record?.state).toBe('starting'));
  rerender();
  rerender();
  expect(app.up).toHaveBeenCalledTimes(1);
  expect(app.up).toHaveBeenCalledWith('proc-1');
});

it.each(['up', 'degraded', 'installing', 'building', 'starting', 'recovering'] as const)(
  'a %s app is never asked to come up',
  (state) => {
    const app = appWith(rec(state));
    const { result } = renderHook(() => useAppLifecycle(ID));
    expect(app.up).not.toHaveBeenCalled();
    expect(result.current.showable).toBe(state === 'up' || state === 'degraded');
  },
);

it('autoUp off asks nothing', () => {
  const app = appWith(rec('down'));
  renderHook(() => useAppLifecycle(ID, { autoUp: false }));
  expect(app.up).not.toHaveBeenCalled();
});

it('Fix it and Cancel are the WebApp actions, and their answer shows at once', async () => {
  const app = appWith(rec('needs_person', { detail: 'port 4400 is held' }));
  const { result } = renderHook(() => useAppLifecycle(ID, { autoUp: false }));
  await act(() => result.current.fixIt());
  expect(app.fix).toHaveBeenCalledTimes(1);
  expect(result.current.record?.state).toBe('recovering');
  await act(() => result.current.stop());
  expect(app.stop).toHaveBeenCalledTimes(1);
  expect(result.current.record?.state).toBe('down');
});

it("claims the fixer's questions while it runs", () => {
  appWith(rec('recovering', { agent_call: 'compute_op-x/call-1' }));
  const { result, unmount } = renderHook(() => useAppLifecycle(ID));
  act(() => {
    expect(deliverClaimedQuestion('compute_op-x/call-1', 'q-1')).toBe(true);
  });
  expect(result.current.questionId).toBe('q-1');
  unmount();
  expect(deliverClaimedQuestion('compute_op-x/call-1', 'q-2')).toBe(false);
});

it('no app named: nothing loads, nothing is asked', () => {
  const { result } = renderHook(() => useAppLifecycle(null));
  expect(result.current.record).toBeNull();
  expect(result.current.loading).toBe(false);
});
