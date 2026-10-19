import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Project, type ProjectLoadResult, type SetupNodeResult, type SetupTreeResult } from '@sdk';
import { ProjectLoadDialogRoot } from '@src/components/project-setup/ProjectLoadDialog';
import { openProjectLoad, useProjectLoadStore } from '@src/components/project-setup/project-load-store';
const projectId = '77777777-7777-4777-8777-777777777777';
const required: ProjectLoadResult = {
  state: 'setup_required',
  detail: 'Install required tools.',
  run: null,
  project_id: projectId,
  asset: null,
};
const payload = { projectId, projectName: 'Example service', initial: required };
afterEach(() => {
  cleanup();
  useProjectLoadStore.getState().setOpen(false);
  vi.restoreAllMocks();
});
/** ``observed``: what the backend answers once the question is open (null: it dropped the verdict). */
function mount(result: ProjectLoadResult = required, observed: ProjectLoadResult | null = result) {
  vi.spyOn(Project, 'loadState').mockResolvedValue(observed);
  // The app's own freshness defaults (ts_sdk/src/lazy/queryClient.ts): under them a seeded verdict
  // counts as fresh for five minutes unless the query itself says otherwise.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 5 * 60 * 1000, refetchOnWindowFocus: false } },
  });
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <ProjectLoadDialogRoot />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  act(() => openProjectLoad({ ...payload, initial: result }));
}
describe('project lifecycle approval', () => {
  it('Not now executes nothing; reopening asks the same question', async () => {
    const load = vi.spyOn(Project, 'load');
    mount();
    expect(await screen.findByText('Example service requires setup')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(screen.queryByTestId('project-load-dialog')).toBeNull();
    expect(load).not.toHaveBeenCalled();
    act(() => openProjectLoad(payload));
    expect(await screen.findByRole('button', { name: 'Set up' })).toBeInTheDocument();
    expect(load).not.toHaveBeenCalled();
  });
  it('before Set up, the dialog shows the first level of what the check found', async () => {
    const node = (id: string, state: SetupNodeResult['state'], detail = '', children: SetupNodeResult[] = []) =>
      ({ id, state, detail, children, shared: false }) as SetupNodeResult;
    const tree: SetupTreeResult = {
      state: 'blocked',
      detail: 'waiting on Deals sync',
      total: 4,
      done: 2,
      ran: false,
      root: node('sales-desk', 'blocked', 'waiting on Deals sync', [
        node('Deals sync', 'blocked', 'waiting on HubSpot key', [node('HubSpot key', 'failed', 'not set')]),
        node('Studio app', 'done'),
      ]),
    };
    const load = vi.spyOn(Project, 'load');
    mount({ ...required, tree });
    expect(await screen.findByTestId('setup-node-Deals sync')).toHaveAttribute('data-state', 'blocked');
    expect(screen.getByTestId('setup-node-Studio app')).toHaveAttribute('data-state', 'done');
    // The count is of the two rows shown, not the run's four nodes.
    expect(screen.getByTestId('setup-tree-progress')).toHaveTextContent('1 of 2 set up');
    // The root is the title, and the second level is the run's business.
    expect(screen.queryByTestId('setup-node-sales-desk')).toBeNull();
    expect(screen.queryByTestId('setup-node-HubSpot key')).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });
  it('a verdict the backend dropped is checked again, and a question no longer true closes', async () => {
    // What it was checked against changed while the question stood (a source turned active).
    const load = vi.spyOn(Project, 'load').mockResolvedValue({ ...required, state: 'ready', detail: '' });
    mount(required, null);
    await waitFor(() => expect(load).toHaveBeenCalledExactlyOnceWith(projectId, { approved: false }));
    await waitFor(() => expect(screen.queryByTestId('project-load-dialog')).toBeNull());
  });
  it('a dropped verdict that still needs setup asks the question again from the fresh check', async () => {
    const fresh = { ...required, detail: 'Connect your own account.' };
    const load = vi.spyOn(Project, 'load').mockResolvedValue(fresh);
    mount(required, null);
    expect(await screen.findByText('Connect your own account.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set up' })).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(1);
  });
  it('only Set up grants explicit approval through the shared Load action', async () => {
    const load = vi.spyOn(Project, 'load').mockResolvedValue({ ...required, state: 'ready', detail: 'Ready' });
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Set up' }));
    await waitFor(() => expect(load).toHaveBeenCalledExactlyOnceWith(projectId, { approved: true }));
    expect(await screen.findByText('Ready')).toBeInTheDocument();
  });
});
