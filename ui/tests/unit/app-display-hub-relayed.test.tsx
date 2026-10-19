/**
 * An app the hub relays (`<audience>--<uuid>.<env>.flowpad.app`, a GCP VM's apps) is offered in a tab
 * of its own: framed, its SameSite=Lax sign-in cookie is never kept (another site than the page) and
 * the frame looped back to the hub. Every other app is framed as before. FLOWPAD-2266.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';

import { isHubRelayed } from '@src/lib/hub-relayed';

const RELAYED = 'https://app--3a9bf849-1963-4005-8b3b-e5209ec3731c.dev.flowpad.app/q/';
const E2B_DOOR = 'https://9027-isbx1234.e2b.dev/q/';
const projectId = '92f5e237-2df9-4a76-8f4e-fe2223c98337';

const display = vi.hoisted(() => ({ src: '' }));
const opened = vi.hoisted(() => vi.fn());

vi.mock('@src/hooks/flow-hooks', () => ({
  hostBrand: () => ({ primary: '', primaryInk: '' }),
  useAppDisplay: () => ({
    loading: false, theme: 'light', view: 'desk', src: display.src, runtime: 'dev', available: ['dev'],
    endpoint: null, idleDev: null,
  }),
}));
vi.mock('@sdk/react/hooks', () => ({ useEntity: () => ({ data: { project_id: projectId }, notFound: false }) }));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ currentDock: null, navigation: { openDock: vi.fn() } }),
}));
vi.mock('@src/hooks/useContext', () => ({ useContext: () => ({ project: { id: projectId } }) }));
vi.mock('@src/components/project-setup/ProjectLoadGate', () => ({
  ProjectLoadGate: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@src/components/display-toolbar', () => ({ WebappDisplayToolbar: () => null }));
vi.mock('@src/components/webapp-display/useWebappDiagnostics', () => ({
  useWebappDiagnostics: () => ({ severity: 'ok', code: 'ok', detail: [], refresh: vi.fn() }),
}));
vi.mock('@src/components/webapp-display/useWebappFix', () => ({
  useWebappFix: () => ({ running: false, toolCount: 0, start: vi.fn(), autoAttempted: false }),
}));
vi.mock('@src/lib/open-external', () => ({ openExternal: opened }));

const { AppDisplayViewer } = await import('@src/pages/flow-page/app-display-viewer');

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const show = (src: string) => {
  display.src = src;
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AppDisplayViewer artifactId={null} microAppId="cf255aa4-1156-45d2-bfa0-3767d01a2e25" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
};
// Other files' frames stay parked in the shared document: look for THIS app's frame only.
const frameOf = (src: string) => document.querySelector(`iframe[src="${src}"]`);

afterEach(() => {
  cleanup();
  opened.mockClear();
});

it('offers an app the hub relays in a tab of its own, opened by the click only', () => {
  const view = show(RELAYED);

  expect(view.getByTestId('app-opens-in-tab')).toHaveTextContent('This app is served externally via Flowpad');
  expect(frameOf(RELAYED)).toBeNull();
  expect(opened).not.toHaveBeenCalled();
  fireEvent.click(view.getByRole('button', { name: 'Open in new tab' }));
  expect(opened).toHaveBeenCalledWith(RELAYED);
});

it('frames a box door (E2B) as before: no tab offered', () => {
  const view = show(E2B_DOOR);

  expect(view.queryByTestId('app-opens-in-tab')).toBeNull();
  expect(frameOf(E2B_DOOR)).not.toBeNull();
});

it('an admin host and a prod host are hub-relayed too', () => {
  expect(isHubRelayed('https://admin--3a9bf849-1963-4005-8b3b-e5209ec3731c.flowpad.app/')).toBe(true);
});

it('a look-alike of the app domain is not', () => {
  expect(isHubRelayed('https://flowpad.app.evil.test/')).toBe(false);
  expect(isHubRelayed('https://notflowpad.app/')).toBe(false);
});

it('the hub itself, a dev server and a non-URL are not', () => {
  expect(isHubRelayed('https://dev.flowpad.ai/dock/vibe')).toBe(false);
  expect(isHubRelayed('http://localhost:5173/')).toBe(false);
  expect(isHubRelayed('about:blank#app')).toBe(false);
});
