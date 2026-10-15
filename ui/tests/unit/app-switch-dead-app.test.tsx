/**
 * Switching from a running app to one whose server is down must not leave the first app on screen:
 * its frame is parked, and the second app shows its own state. (Reported on spora-4: clicking a
 * dead app in the apps list seemed to keep showing the running one.)
 */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { VISIBILITY_MESSAGE } from '@sdk/apps/host';

const A = 'cf255aa4-1156-45d2-bfa0-3767d01a2e25';
const B = '055dd8ce-97ac-4fa2-9aa8-a3b2e1f1d0af';
const SRC_A = 'about:blank#app-a';
const projectId = '92f5e237-2df9-4a76-8f4e-fe2223c98337';

const display = vi.hoisted(() => ({ byApp: {} as Record<string, Record<string, unknown>> }));

vi.mock('@src/hooks/flow-hooks', () => ({
  hostBrand: () => ({ primary: '', primaryInk: '' }),
  useAppDisplay: (address: { microAppId: string }) => display.byApp[address.microAppId],
}));
vi.mock('@sdk/react/hooks', () => ({
  useEntity: () => ({ data: { project_id: projectId }, notFound: false }),
}));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ currentDock: null, navigation: { openDock: vi.fn() } }),
}));
vi.mock('@src/hooks/useContext', () => ({ useContext: () => ({ project: { id: projectId } }) }));
vi.mock('@src/components/webapp-display/WebappSetupGate', () => ({
  WebappSetupGate: ({ webappId }: { webappId: string }) => <p data-testid="setup-gate">{webappId}</p>,
}));
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

const { AppDisplayViewer } = await import('@src/pages/flow-page/app-display-viewer');

const base = { loading: false, theme: 'light', view: 'desk' };

afterEach(cleanup);

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const routed = (node: ReactNode) => (
  <QueryClientProvider client={client}>
    <MemoryRouter>{node}</MemoryRouter>
  </QueryClientProvider>
);

it('a dead app opened after a running one shows its own state, and the running app is parked', () => {
  display.byApp[A] = { ...base, src: SRC_A, runtime: 'dev', available: ['dev'], endpoint: null, idleDev: null };
  // B's route exists but its server does not answer: no direct url, so no src.
  display.byApp[B] = {
    ...base,
    src: '',
    runtime: null,
    available: [],
    endpoint: null,
    idleDev: { webapp_id: B, project_id: projectId },
  };

  const view = render(routed(<AppDisplayViewer artifactId={null} microAppId={A} />));
  const frame = document.querySelector<HTMLIFrameElement>(`iframe[src="${SRC_A}"]`)!;
  act(() => {
    frame.dispatchEvent(new Event('load'));
  });
  // What the frame's guest is told about its visibility — the parked state, not its CSS.
  const told: { type?: string; hidden?: boolean }[] = [];
  Object.defineProperty(frame, 'contentWindow', { get: () => ({ postMessage: (m: never) => told.push(m) }) });
  const hidden = () => told.filter((m) => m.type === VISIBILITY_MESSAGE).at(-1)?.hidden;

  view.rerender(routed(<AppDisplayViewer artifactId={null} microAppId={B} />));

  expect(view.getByTestId('setup-gate')).toHaveTextContent(B);
  expect(hidden()).toBe(true);
});
