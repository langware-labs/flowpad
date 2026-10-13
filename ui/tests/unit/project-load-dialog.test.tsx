import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Project, type ProjectLoadResult } from '@sdk';
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
function mount() {
  vi.spyOn(Project, 'loadState').mockResolvedValue(required);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ProjectLoadDialogRoot />
    </QueryClientProvider>,
  );
  act(() => openProjectLoad(payload));
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
    const node = (id: string, state: 'done' | 'blocked' | 'failed', detail = '', children: object[] = []) => ({
      id,
      label: id,
      level: 0,
      state,
      detail,
      children,
      shared: false,
      independent: false,
    });
    const tree = {
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
    vi.spyOn(Project, 'loadState').mockResolvedValue({ ...required, tree } as ProjectLoadResult);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ProjectLoadDialogRoot />
      </QueryClientProvider>,
    );
    act(() => openProjectLoad({ ...payload, initial: { ...required, tree } as ProjectLoadResult }));
    expect(await screen.findByTestId('setup-node-Deals sync')).toHaveAttribute('data-state', 'blocked');
    expect(screen.getByTestId('setup-node-Studio app')).toHaveAttribute('data-state', 'done');
    expect(screen.getByTestId('setup-tree-progress')).toHaveTextContent('2 of 4 set up');
    // The root is the title, and the second level is the run's business.
    expect(screen.queryByTestId('setup-node-sales-desk')).toBeNull();
    expect(screen.queryByTestId('setup-node-HubSpot key')).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });
  it('only Set up grants explicit approval through the shared Load action', async () => {
    const load = vi.spyOn(Project, 'load').mockResolvedValue({ ...required, state: 'ready', detail: 'Ready' });
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Set up' }));
    await waitFor(() => expect(load).toHaveBeenCalledExactlyOnceWith(projectId, { approved: true }));
    expect(await screen.findByText('Ready')).toBeInTheDocument();
  });
});
