import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useNavigate } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { Project, type ProjectLoadResult } from '@sdk';
import { ProjectLoadGate } from '@src/components/project-setup/ProjectLoadGate';
import { useProjectLoadStore } from '@src/components/project-setup/project-load-store';

vi.mock('@sdk/react/hooks', () => ({ useEntity: () => ({ data: { displayName: 'Service' } }), useWatch: () => {} }));
vi.mock('@src/hooks/use-process-progress-info', () => ({
  useProcessProgressInfo: () => ({ statusMessage: 'Killing the process on port 4400', activityLabel: null, elapsedTime: '12s' }),
}));
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

it('an app that validates opens at once, never loads, and a re-open shows it on the first frame', async () => {
  const asset = 'micro_app-11111111-1111-4111-8111-111111111111';
  vi.spyOn(Project, 'loadState').mockResolvedValue(ready);
  const validate = vi.spyOn(Project, 'validateLoad').mockResolvedValue({ ...ready, asset });
  const load = vi.spyOn(Project, 'load').mockResolvedValue(ready);
  const first = gate(asset);
  expect(await screen.findByText('Service home')).toBeInTheDocument();
  expect(load).not.toHaveBeenCalled();
  first.unmount();
  gate(asset);
  // No await: the verdict this window already holds is rendered synchronously, checked behind it.
  expect(screen.getByText('Service home')).toBeInTheDocument();
  await waitFor(() => expect(validate).toHaveBeenCalledTimes(2));
  expect(load).not.toHaveBeenCalled();
});

it('an app that does not validate is loaded, and a load-only run says Starting, not the setup tree', async () => {
  const asset = 'micro_app-22222222-2222-4222-8222-222222222222';
  const starting: ProjectLoadResult = { ...ready, state: 'running', run: 'run-1', phase: 'load' };
  vi.spyOn(Project, 'validateLoad').mockResolvedValue(null);
  vi.spyOn(Project, 'loadState').mockResolvedValue(starting);
  vi.spyOn(Project, 'setupRun').mockResolvedValue({ tree: null } as never);
  const load = vi.spyOn(Project, 'load').mockResolvedValue(starting);
  gate(asset);
  await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  expect(await screen.findByText('Starting…')).toBeInTheDocument();
  expect(screen.queryByText('Service home')).not.toBeInTheDocument();
});

function failedForGood() {
  const final: ProjectLoadResult = { ...ready, state: 'failed', detail: 'Service: port 4400 is held', setup_available: false };
  vi.spyOn(Project, 'loadState').mockResolvedValue(final);
  return final;
}

it('a failed setup offers Fix it first, Cancel beside it, and Try again only as a small link', async () => {
  const final = failedForGood();
  vi.spyOn(Project, 'load').mockResolvedValue(final);
  gate();
  expect(await screen.findByRole('button', { name: 'Fix it' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Try again' }).className).toContain('text-muted-foreground');
});

it('Fix it runs setup again — the setup-fixer is a step of that run — and shows it under way', async () => {
  const final = failedForGood();
  let settle: (r: ProjectLoadResult) => void = () => {};
  const load = vi.spyOn(Project, 'load').mockResolvedValueOnce(final);
  gate();
  await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  load.mockReturnValueOnce(new Promise((r) => (settle = r)));
  await userEvent.click(await screen.findByRole('button', { name: 'Fix it' }));
  expect(load).toHaveBeenLastCalledWith(projectId, { approved: true });
  expect(screen.getByTestId('setup-fix-line')).toHaveTextContent('Killing the process on port 4400');
  settle(final);
});

it('a setup run that still fails says so, with the step in its own words', async () => {
  const final = failedForGood();
  // Each answer is a new verdict, as the backend sends one.
  vi.spyOn(Project, 'load').mockImplementation(() => Promise.resolve({ ...final }));
  gate();
  await userEvent.click(await screen.findByRole('button', { name: 'Fix it' }));
  expect(await screen.findByText(/The fixer could not repair this setup/)).toBeInTheDocument();
});

it('Cancel stops the setup run the fix is', async () => {
  const final = failedForGood();
  const load = vi.spyOn(Project, 'load').mockResolvedValueOnce(final);
  load.mockReturnValue(new Promise(() => {}));
  const stop = vi.spyOn(Project, 'stopSetup').mockResolvedValue(true);
  gate();
  await userEvent.click(await screen.findByRole('button', { name: 'Fix it' }));
  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(stop).toHaveBeenCalledWith(projectId, '');
  expect(screen.queryByTestId('setup-fix-line')).not.toBeInTheDocument();
});
