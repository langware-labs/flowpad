/**
 * An app the hub relays (`<audience>--<uuid>.<app_domain>`, a GCP VM's apps) opens in its own tab.
 * Framed, its SameSite=Lax sign-in cookie is never kept (another site than the page), and the
 * frame looped back to the hub until the browser gave up ("redirected you too many times").
 * Every other app — a dev server, a box's own door — is framed as before. FLOWPAD-2266.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { isHubRelayed } from '@src/lib/hub-relayed';

const APP = 'cf255aa4-1156-45d2-bfa0-3767d01a2e25';
const projectId = '92f5e237-2df9-4a76-8f4e-fe2223c98337';
const RELAYED = 'https://app--3a9bf849-1963-4005-8b3b-e5209ec3731c.dev.flowpad.app/q/';

const display = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
const opened = vi.hoisted(() => vi.fn());

vi.mock('@src/hooks/flow-hooks', () => ({
  hostBrand: () => ({ primary: '', primaryInk: '' }),
  useAppDisplay: () => display.current,
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
const show = () =>
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AppDisplayViewer artifactId={null} microAppId={APP} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
const served = (src: string) => ({
  loading: false, theme: 'light', view: 'desk', src, runtime: 'dev', available: ['dev'], endpoint: null, idleDev: null,
});

afterEach(() => {
  cleanup();
  opened.mockClear();
});

describe('isHubRelayed', () => {
  it('a host under the app domain, dev or prod', () => {
    expect(isHubRelayed(RELAYED)).toBe(true);
    expect(isHubRelayed('https://admin--3a9bf849-1963-4005-8b3b-e5209ec3731c.flowpad.app/')).toBe(true);
  });

  it('a box door, a dev server, the hub itself, a look-alike and a non-URL are not', () => {
    expect(isHubRelayed('https://9027-isbx1234.e2b.dev/q/')).toBe(false);
    expect(isHubRelayed('http://localhost:5173/')).toBe(false);
    expect(isHubRelayed('https://dev.flowpad.ai/dock/vibe')).toBe(false);
    expect(isHubRelayed('https://flowpad.app.evil.test/')).toBe(false);
    expect(isHubRelayed('https://notflowpad.app/')).toBe(false);
    expect(isHubRelayed('about:blank#app')).toBe(false);
  });
});

describe('the app display', () => {
  it('opens an app the hub relays in its own tab instead of a frame that loops — once', () => {
    display.current = served(RELAYED);
    const view = show();

    expect(opened).toHaveBeenCalledWith(RELAYED);
    expect(view.getByTestId('app-opens-in-tab')).toBeInTheDocument();
    expect(document.querySelector('iframe')).toBeNull();

    cleanup();
    const again = show(); // the dock shown again: no second tab on its own, the button opens one
    expect(opened).toHaveBeenCalledTimes(1);
    fireEvent.click(again.getByRole('button', { name: 'Open in new tab' }));
    expect(opened).toHaveBeenCalledTimes(2);
  });

  it('frames a box door on another site (E2B) as before', () => {
    const door = 'https://9027-isbx1234.e2b.dev/q/';
    display.current = served(door);
    const view = show();

    expect(view.queryByTestId('app-opens-in-tab')).toBeNull();
    expect(document.querySelector(`iframe[src="${door}"]`)).not.toBeNull();
    expect(opened).not.toHaveBeenCalled();
  });
});
