import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useNavigate } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { Project, type ProjectLoadResult } from '@sdk';
import { ProjectLoadGate } from '@src/components/project-setup/ProjectLoadGate';
import { useProjectLoadStore } from '@src/components/project-setup/project-load-store';

vi.mock('@sdk/react/hooks', () => ({ useEntity: () => ({ data: { displayName: 'Service' } }) }));
const projectId = '77777777-7777-4777-8777-777777777777';
const ready: ProjectLoadResult = { state: 'ready', detail: 'Ready', run: null, project_id: projectId, asset: null };

afterEach(() => {
  cleanup();
  useProjectLoadStore.getState().setOpen(false);
  vi.restoreAllMocks();
});

function Reopen() {
  const navigate = useNavigate();
  return <button onClick={() => { void navigate('/dock/app/service'); }}>Open</button>;
}

it('runs Load again when the same completed dependency home is opened, without reapproving setup', async () => {
  vi.spyOn(Project, 'loadState').mockResolvedValue(ready);
  const load = vi.spyOn(Project, 'load').mockResolvedValue(ready);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/dock/app/service']}>
        <Reopen />
        <ProjectLoadGate projectId={projectId}><p>Service home</p></ProjectLoadGate>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  expect(await screen.findByText('Service home')).toBeInTheDocument();
  expect(load).toHaveBeenCalledTimes(1);
  await userEvent.click(screen.getByRole('button', { name: 'Open' }));
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  expect(await screen.findByText('Service home')).toBeInTheDocument();
  expect(load.mock.calls).toEqual([[projectId, { approved: false }], [projectId, { approved: false }]]);
  expect(useProjectLoadStore.getState().open).toBe(false);
});

function gate(asset = '') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/dock/app/service']}>
        <ProjectLoadGate projectId={projectId} asset={asset}><p>Service home</p></ProjectLoadGate>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

it('a failed load runs setup once, unasked, and then shows the app', async () => {
  const failed: ProjectLoadResult = { ...ready, state: 'failed', detail: 'Service: it cannot start', setup_available: true };
  vi.spyOn(Project, 'loadState').mockResolvedValue(failed);
  vi.spyOn(Project, 'setupRun').mockResolvedValue({ run: '', running: false, tree: null });
  const load = vi.spyOn(Project, 'load').mockImplementation(async (_id, options) => (options?.approved ? ready : failed));
  gate();
  expect(await screen.findByText('Service home')).toBeInTheDocument();
  expect(load.mock.calls).toEqual([[projectId, { approved: false }], [projectId, { approved: true }]]);
});

it('a load that still fails after its setup says why and does not loop', async () => {
  const offered: ProjectLoadResult = { ...ready, state: 'failed', detail: 'Service: it cannot start', setup_available: true };
  const final: ProjectLoadResult = { ...offered, setup_available: false };
  vi.spyOn(Project, 'loadState').mockResolvedValue(offered);
  vi.spyOn(Project, 'setupRun').mockResolvedValue({ run: '', running: false, tree: null });
  const load = vi.spyOn(Project, 'load').mockImplementation(async (_id, options) => (options?.approved ? final : offered));
  gate();
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  expect(await screen.findByText('Service: it cannot start')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  await new Promise((r) => setTimeout(r, 50));
  expect(load).toHaveBeenCalledTimes(2);
});

it('a project that is gone is said to be gone, with no retry that could never work', async () => {
  vi.spyOn(Project, 'loadState').mockResolvedValue(null);
  vi.spyOn(Project, 'load').mockRejectedValue(Object.assign(new Error('Request failed with status code 404'), { response: { status: 404 } }));
  gate();
  expect(await screen.findByTestId('project-load-missing')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  expect(screen.queryByText(/status code 404/)).not.toBeInTheDocument();
});

it('an app that needs setup sets up in place: no dialog over it, then the app', async () => {
  const required: ProjectLoadResult = { ...ready, state: 'setup_required', detail: 'Service: waiting on Google Cloud' };
  vi.spyOn(Project, 'loadState').mockResolvedValue(required);
  vi.spyOn(Project, 'setupRun').mockResolvedValue({ run: '', running: false, tree: null });
  const load = vi.spyOn(Project, 'load').mockImplementation(async (_id, options) => (options?.approved ? ready : required));
  const asset = 'micro_app-77777777-7777-4777-8777-777777777778';
  gate(asset);
  expect(await screen.findByText('Service home')).toBeInTheDocument();
  expect(load.mock.calls).toEqual([[projectId, { approved: false, asset }], [projectId, { approved: true, asset }]]);
  expect(useProjectLoadStore.getState().open).toBe(false);
});

it('a gate for the project alone offers Set up instead of starting the whole setup by itself', async () => {
  const required: ProjectLoadResult = { ...ready, state: 'setup_required', detail: 'Service: waiting on Google Cloud' };
  vi.spyOn(Project, 'loadState').mockResolvedValue(required);
  const load = vi.spyOn(Project, 'load').mockImplementation(async (_id, options) => (options?.approved ? ready : required));
  gate();
  const setUp = await screen.findByRole('button', { name: 'Set up' });
  expect(load.mock.calls).toEqual([[projectId, { approved: false }]]);
  await userEvent.click(setUp);
  await waitFor(() => expect(load.mock.calls.at(-1)).toEqual([projectId, { approved: true }]));
  expect(useProjectLoadStore.getState().open).toBe(false);
});
