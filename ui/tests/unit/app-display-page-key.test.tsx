/**
 * An app view keeps ONE frame for as long as it lives. Its frame address carries the app's page key,
 * which never changes — so going somewhere else and back, whatever key the URL then shows, creates no
 * second frame. (0.2.274 re-keyed every open app on every navigation: a frame and a socket each time.)
 * A key an agent opened the app with is the view's own, and the server must know it.
 */
import { apiClient } from '@sdk';
import { cleanup, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { DockPointer, STATE_KEY_PARAM } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';

const APP = 'http://localhost:9007/api/v1/graph/service_endpoint/e1/service/page-key-app/';
const APP_KEY = 'a'.repeat(32);
const AGENT_KEY = 'g'.repeat(32);
const held = globalThis as { __FLOWPAD_STATE_KEY__?: string };

const url = vi.hoisted(() => ({ dock: null as unknown }));
const known = vi.hoisted(() => ({ keys: new Set<string>() }));

vi.mock('@src/hooks/flow-hooks', () => ({
  hostBrand: () => ({ primary: '', primaryInk: '' }),
  useAppDisplay: () => ({
    loading: false, theme: 'light', view: 'desk', src: APP, runtime: 'served', available: ['served'],
    endpoint: null, idleDev: null,
  }),
}));
vi.mock('@sdk/react/hooks', () => ({ useEntity: () => ({ data: null, notFound: false }) }));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ currentDock: url.dock, navigation: { openDock: vi.fn() } }),
}));
vi.mock('@src/hooks/useContext', () => ({ useContext: () => ({ project: null }) }));
vi.mock('@src/components/display-toolbar', () => ({ WebappDisplayToolbar: () => null, useDisplayChromeSlot: () => null }));
vi.mock('@src/components/webapp-display/useAppLifecycle', () => ({
  useAppLifecycle: () => ({
    app: null, record: null, loading: false, notFound: false, showable: true, questionId: null,
    settleQuestion: () => {}, fixIt: async () => {}, stop: async () => {}, reportPage: async () => null,
  }),
}));

const { AppDisplayViewer } = await import('@src/pages/flow-page/app-display-viewer');

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const view = (stateKey: string | null) => (
  <QueryClientProvider client={client}>
    <MemoryRouter>
      <AppDisplayViewer artifactId={null} endpointId="e1" stateKey={stateKey} />
    </MemoryRouter>
  </QueryClientProvider>
);
/** The addresses of this app's frames (other files' frames stay parked in the shared document). */
const frames = () =>
  [...document.querySelectorAll('iframe')].map((frame) => frame.getAttribute('src') ?? '').filter((src) => src.startsWith(APP));

beforeEach(() => {
  held.__FLOWPAD_STATE_KEY__ = APP_KEY;
  known.keys = new Set([APP_KEY, AGENT_KEY]);
  url.dock = new DockPointer(ViewType.APP, 'service_endpoint-e1');
  // The local server, asked about a key.
  vi.spyOn(apiClient, 'get').mockImplementation(async (_url: string, config?: { params?: { probe?: string } }) => ({
    enforced: true,
    state: null,
    probed: known.keys.has(config?.params?.probe ?? '') ? { context: {} } : null,
  }));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete held.__FLOWPAD_STATE_KEY__;  window.sessionStorage.clear(); // the key is remembered for a reload: do not hand it to the next test file
});

it('keeps one frame while the URL moves to other pages and their keys', async () => {
  const shown = render(view(null));
  await waitFor(() => expect(frames()).toEqual([`${APP}?state=${APP_KEY}`]));

  for (const key of ['x'.repeat(32), 'y'.repeat(32), undefined]) {
    const elsewhere = new DockPointer(ViewType.STREAM_INBOX, '');
    url.dock = key ? elsewhere.withOption(STATE_KEY_PARAM, key) : elsewhere;
    shown.rerender(view(null));
  }

  expect(frames()).toEqual([`${APP}?state=${APP_KEY}`]);
});

it("runs with the key an agent opened it with, and keeps it when revisited with the app's key", async () => {
  const shown = render(view(AGENT_KEY));
  await waitFor(() => expect(frames()).toContain(`${APP}?state=${AGENT_KEY}`));
  const before = frames();

  shown.rerender(view(APP_KEY));

  expect(frames()).toEqual(before);
});

it('ignores a key the server does not know', async () => {
  render(view('z'.repeat(32)));

  await waitFor(() => expect(frames()).toContain(`${APP}?state=${APP_KEY}`));
  expect(frames().some((src) => src.includes('z'.repeat(32)))).toBe(false);
});
