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
  it('only Set up grants explicit approval through the shared Load action', async () => {
    const load = vi.spyOn(Project, 'load').mockResolvedValue({ ...required, state: 'ready', detail: 'Ready' });
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Set up' }));
    await waitFor(() => expect(load).toHaveBeenCalledExactlyOnceWith(projectId, { approved: true }));
    expect(await screen.findByText('Ready')).toBeInTheDocument();
  });
});
