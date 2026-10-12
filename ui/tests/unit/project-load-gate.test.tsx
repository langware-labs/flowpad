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
