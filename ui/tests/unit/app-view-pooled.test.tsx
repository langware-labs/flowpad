/**
 * An app view lives as long as its TAB (docs/navigation/dock-loading.md, I6): `<AppPool/>` renders
 * it once and `AppSlot` only lends it a place. Switching away and back keeps the same viewer and the
 * same frame; a new content epoch (a Vibe turn end) reloads the frame once without a remount; a
 * theme flip never touches the frame's address.
 */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { forwardRef, useEffect, useImperativeHandle, useRef, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  viewerMounts: 0,
  displayMounts: 0,
  refreshes: 0,
  theme: 'light',
  display: {} as Record<string, unknown>,
  entity: undefined as unknown,
}));

vi.mock('@src/hooks/flow-hooks', async (orig) => ({
  ...(await orig<typeof import('@src/hooks/flow-hooks')>()),
  useAppDisplay: () => h.display,
}));
vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: h.theme }) }));
vi.mock('@sdk/react/hooks', async (orig) => ({
  ...(await orig<typeof import('@sdk/react/hooks')>()),
  useEntity: () => ({ data: h.entity, isLoading: false, notFound: false }),
}));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ currentDock: null, navigation: { openDock: vi.fn() } }),
  useCurrentDock: () => null,
}));
vi.mock('@src/hooks/useContext', () => ({ useContext: () => ({ project: null }) }));
vi.mock('@src/tabs/use-tab-manager', () => ({ useOpenTabHashes: () => new Set(['tab-a', 'tab-b']) }));
vi.mock('@src/components/webapp-display/WebappDisplay', async () => {
  const { default: PersistentIframe } = await import('@src/components/persistent-iframe');
  return {
    WebappDisplay: forwardRef<unknown, { src: string; testId?: string }>(function WebappDisplay({ src, testId }, ref) {
      const inner = useRef<{ refresh: () => void; postToGuest: (m: unknown) => void; isGuest: () => boolean }>(null);
      useEffect(() => {
        h.displayMounts += 1;
      }, []);
      useImperativeHandle(ref, () => ({
        refresh: () => {
          h.refreshes += 1;
          inner.current?.refresh();
        },
        postToGuest: (m: unknown) => inner.current?.postToGuest(m),
        isGuest: () => false,
      }));
      return <PersistentIframe ref={inner as never} src={src} testId={testId} />;
    }),
  };
});
vi.mock('@src/pages/flow-page/app-display-viewer', async (orig) => {
  const real = await orig<typeof import('@src/pages/flow-page/app-display-viewer')>();
  return {
    ...real,
    AppDisplayViewer: (props: Parameters<typeof real.AppDisplayViewer>[0]) => {
      useEffect(() => {
        h.viewerMounts += 1;
      }, []);
      return <real.AppDisplayViewer {...props} />;
    },
  };
});

const { tabManager } = await import('@sdk');
const { AppPool } = await import('@src/components/app-pool/AppPool');
const { AppSlot } = await import('@src/components/app-pool/AppSlot');
const { appPool } = await import('@src/components/terminal/terminal-pool');

const SRC = 'http://localhost:49650/tasks-app/';
const VIEWER = { artifactId: null, endpointId: '671e7350-2fe3-416f-b497-a1bfc494274a', route: 'tasks-app' };

beforeEach(() => {
  Object.assign(h, { viewerMounts: 0, displayMounts: 0, refreshes: 0, theme: 'light', entity: undefined });
  h.display = {
    loading: false,
    theme: 'light',
    view: 'desk',
    src: SRC,
    runtime: 'dev',
    available: ['dev'],
    idleDev: null,
    endpoint: { id: 'ep', project_id: null, webapp_id: null, backend: { type: 'proxy', port: 49650 } },
  };
  vi.spyOn(tabManager, 'isHydrated').mockReturnValue(true);
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
});
afterEach(() => {
  cleanup();
  appPool.resetForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function Harness({ show, epoch }: { show: 'app' | 'other'; epoch: number }) {
  return (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <AppPool />
        {show === 'app' ? (
          <AppSlot viewKey="app:host-1:service_endpoint-x:tasks-app" tabHash="tab-a" viewer={{ ...VIEWER, reloadKey: epoch }} />
        ) : (
          <div data-testid="other-tab" />
        )}
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const frame = () => document.querySelector('iframe[data-testid="vibe-app-frame"]');

it('switching to another tab and back keeps the same viewer and the same frame', async () => {
  const view = render(<Harness show="app" epoch={1} />);
  await act(async () => {});
  const first = frame();
  expect(first).not.toBeNull();
  expect(h.viewerMounts).toBe(1);

  view.rerender(<Harness show="other" epoch={1} />);
  await act(async () => {});
  // Kept, but not on screen: its container measures nothing.
  expect(appPool.getSnapshot().mounted.has('app:host-1:service_endpoint-x:tasks-app')).toBe(true);
  expect((document.querySelector('[data-app-key]') as HTMLElement).style.display).toBe('none');

  view.rerender(<Harness show="app" epoch={1} />);
  await act(async () => {});
  expect(h.viewerMounts).toBe(1);
  expect(h.displayMounts).toBe(1);
  expect(frame()).toBe(first);
  expect(h.refreshes).toBe(0);
});

it('a new content epoch reloads the frame once, without a remount', async () => {
  const view = render(<Harness show="app" epoch={1} />);
  await act(async () => {});
  const first = frame();
  view.rerender(<Harness show="app" epoch={2} />);
  await act(async () => {});
  expect(h.refreshes).toBe(1);
  expect(h.viewerMounts).toBe(1);
  expect(h.displayMounts).toBe(1);
  expect(frame()).toBe(first);
});

it('a theme flip leaves the frame address alone', async () => {
  const { useAppDisplay } = await vi.importActual<typeof import('@src/hooks/flow-hooks/useAppDisplay')>(
    '@src/hooks/flow-hooks/useAppDisplay',
  );
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      {children}
    </QueryClientProvider>
  );
  const { ServiceEndpoint } = await import('@sdk');
  h.entity = new ServiceEndpoint({
    id: VIEWER.endpointId,
    name: 'app',
    subkind: 'app',
    protocol: { spec_kind: 'web.app', entry: 'index.html' },
    backend: { type: 'routed', routes: { 'tasks-app': { backend: { type: 'static', root: '/tmp/x' }, webapp_id: null, artifact_id: null } } },
  } as never);
  const address = { artifactId: null, microAppId: null, endpointId: VIEWER.endpointId, route: 'tasks-app', options: { source: 'x' } };
  const hook = renderHook(() => useAppDisplay(address, null), { wrapper });
  const before = hook.result.current.src;
  h.theme = 'dark';
  hook.rerender();
  expect(hook.result.current.theme).toBe('dark');
  expect(before).toContain('source=x');
  expect(before).not.toMatch(/[?&](theme|view|primary)=/);
  expect(hook.result.current.src).toBe(before);
});
