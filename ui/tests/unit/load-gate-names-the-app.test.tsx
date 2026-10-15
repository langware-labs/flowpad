import '@testing-library/jest-dom/vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { Project, type ProjectLoadResult } from '@sdk';
import { OwnerLoadGate } from '@src/components/project-setup/OwnerLoadGate';
import { useProjectLoadStore } from '@src/components/project-setup/project-load-store';
import { WebappSetupGate } from '@src/components/webapp-display/WebappSetupGate';

// A gate that shows ONE app must load THAT app. Asked about the project alone, the backend settles
// without an app that is not installed: it starts a server that cannot run, calls the failed run
// ready, and the app's screen asks again — the start loop behind "the app never opens at home".
const projectId = '77777777-7777-4777-8777-777777777777';
const appId = '49bebcda-996c-5bfe-ad14-5c4b6fdc2f11';
const app = `micro_app-${appId}`;

vi.mock('@sdk/react/hooks', () => ({
  useEntity: () => ({ data: { project_id: projectId, displayName: 'Service' }, isLoading: false }),
}));
vi.mock('@src/components/entity-execution-panel/hooks/useProcessesForTarget', () => ({
  useProcessesForTarget: () => ({ processes: [] }),
}));

afterEach(() => {
  cleanup();
  useProjectLoadStore.getState().setOpen(false);
  vi.restoreAllMocks();
});

/** The backend as it answers a Load that names no app: it runs, and the run is "ready". */
function backend() {
  const running: ProjectLoadResult = { state: 'running', detail: '', run: 'setup-run', project_id: projectId, asset: null };
  vi.spyOn(Project, 'loadState').mockResolvedValue(running);
  vi.spyOn(Project, 'setupRun').mockResolvedValue({ run: 'setup-run', running: true, tree: null });
  return vi.spyOn(Project, 'load').mockResolvedValue(running);
}

function open(gate: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/dock/app/${app}`]}>{gate}</MemoryRouter>
    </QueryClientProvider>,
  );
}

it('the gate on an app dock loads the app it shows, not the bare project', async () => {
  const load = backend();
  open(<OwnerLoadGate urlProject={projectId} appId={appId} display=""><p>app</p></OwnerLoadGate>);
  await waitFor(() => expect(load).toHaveBeenCalled());
  expect(load.mock.calls[0]).toEqual([projectId, { approved: false, asset: app }]);
});

it('the gate an app without a server falls back to loads that app too', async () => {
  const load = backend();
  open(<WebappSetupGate projectId={projectId} webappId={appId} />);
  await waitFor(() => expect(load).toHaveBeenCalled());
  expect(load.mock.calls[0]).toEqual([projectId, { approved: false, asset: app }]);
});
