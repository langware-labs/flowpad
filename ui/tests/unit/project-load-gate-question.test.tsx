/**
 * While a setup run asks something, the question IS the screen: the steps list (and its counts)
 * stays out of the way until nothing is asked and the run is just running.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { Project, type ProjectLoadResult, type SetupNodeResult } from '@sdk';

const h = vi.hoisted(() => ({ question: null as string | null }));
// Project setup waits for the first-run wizard (`first-run-gate.tsx`); here that wizard is done.
vi.mock('@src/components/project-setup/first-run-gate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@src/components/project-setup/first-run-gate')>()),
  useFirstRunGate: () => ({ state: 'open', continueAnyway: vi.fn() }),
}));

vi.mock('@sdk/react/hooks', () => ({ useEntity: () => ({ data: { displayName: 'Service' } }) }));
vi.mock('@src/components/ask/ask-claims', () => ({
  claimAskRun: () => () => {},
  openQuestionOf: async () => h.question,
}));
vi.mock('@src/components/entity-execution-panel/hooks/useProcessesForTarget', () => ({
  useProcessesForTarget: () => ({ processes: [] }),
}));
vi.mock('@src/components/ask/AskForm', () => ({ AskForm: () => <p>the question</p> }));

import { ProjectLoadGate } from '@src/components/project-setup/ProjectLoadGate';

const projectId = '77777777-7777-4777-8777-777777777777';
const node = (id: string, label: string, children: SetupNodeResult[] = []): SetupNodeResult => ({
  id, label, level: 0, state: 'running', detail: '', prepare: null, run: null, children, shared: false,
});
const running: ProjectLoadResult = { state: 'running', detail: 'Setting up', run: 'run-1', project_id: projectId, asset: null };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  h.question = null;
});

async function gate(question: string | null) {
  h.question = question;
  vi.spyOn(Project, 'loadState').mockResolvedValue(running);
  vi.spyOn(Project, 'load').mockResolvedValue(running);
  vi.spyOn(Project, 'setupRun').mockResolvedValue({
    run: 'run-1', running: true, tree: { root: node('root', 'Service', [node('gc', 'Google Cloud step')]) } as never,
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/dock/app/service']}>
        <ProjectLoadGate projectId={projectId}><p>Service home</p></ProjectLoadGate>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

it('hides the steps while a question is open', async () => {
  await gate('q1');
  expect(await screen.findByText('the question')).toBeInTheDocument();
  expect(screen.queryByText('Google Cloud step')).not.toBeInTheDocument();
});

it('shows the steps once nothing is asked', async () => {
  await gate(null);
  expect(await screen.findByText('Google Cloud step')).toBeInTheDocument();
});
