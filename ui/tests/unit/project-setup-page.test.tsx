/**
 * ProjectSetupPage — every step with how it stands (left / ready / skipped), Rerun runs the whole tree, a
 * step's Run runs the tree rooted at that step's node, and the last run's time is said.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Project, type ProjectReadiness, type ProjectSetupRequirement } from '@sdk';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { openDock } = vi.hoisted(() => ({ openDock: vi.fn() }));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ currentDock: null, navigation: { openDock } }),
  useCurrentDock: () => null,
}));
vi.mock('@src/components/credentials/use-credentials', () => ({
  useCredentials: () => ({ status: { credentials: [] }, templates: [], ready: true, refresh: vi.fn() }),
}));
vi.mock('@src/components/ask/AskForm', () => ({ AskForm: () => <div data-testid="ask-form" /> }));
vi.mock('@src/components/ask/ask-claims', () => ({
  claimAskRun: () => () => {},
  openQuestionOf: async () => null,
}));

import { ProjectSetupPage } from '@src/components/project-setup/ProjectSetupPage';

const PID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const req = (over: Partial<ProjectSetupRequirement>): ProjectSetupRequirement => ({
  kind: 'pack',
  name: 'demo-cloud',
  title: 'Demo Cloud',
  typeid: 'credential-11111111-1111-4111-8111-111111111111',
  vars: [],
  used_by: ['project'],
  note: '',
  required: true,
  skipped: null,
  can_skip_always: false,
  why_not_always: '',
  node: 'credential:demo-cloud',
  ...over,
});
const READINESS: ProjectReadiness = {
  project_id: PID,
  ready: false,
  to_do: [req({ needed_for: 'Sign in with democli' })],
  gaps: [],
  set_up: [
    req({
      kind: 'webapp',
      name: 'Demo App',
      title: 'Demo App',
      typeid: 'micro_app-22222222-2222-4222-8222-222222222222',
      node: 'micro_app-22222222-2222-4222-8222-222222222222',
      satisfied: true,
    }),
  ],
};

describe('ProjectSetupPage', () => {
  beforeEach(() => {
    vi.spyOn(Project, 'setupRequirements').mockResolvedValue(READINESS);
    vi.spyOn(Project, 'setupRun').mockResolvedValue({
      run: 'r',
      running: false,
      tree: {
        state: 'done',
        detail: '',
        root: null,
        total: 0,
        done: 0,
        ran: true,
        finished_at: '2026-10-28T12:02:00Z',
      },
    } as never);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('lists what is left and what is ready, with the left count and the last run', async () => {
    render(<ProjectSetupPage projectId={PID} projectName="owed-demo" />);
    expect((await screen.findByTestId('project-setup-step-demo-cloud')).dataset.status).toBe('todo');
    expect(screen.getByTestId('project-setup-step-webapp-Demo App').dataset.status).toBe('ready');
    expect(screen.getByTestId('project-setup-page-chip').textContent).toBe('1 left');
    expect(await screen.findByTestId('project-setup-last-run')).toBeTruthy();
  });

  it('Rerun runs the whole tree; a step Run runs only that step', async () => {
    const start = vi.spyOn(Project, 'startSetup').mockResolvedValue('run');
    render(<ProjectSetupPage projectId={PID} projectName="owed-demo" />);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('project-setup-step-run-webapp-Demo App'));
    await waitFor(() => expect(start).toHaveBeenCalledWith(PID, 'micro_app-22222222-2222-4222-8222-222222222222'));
    cleanup();
    start.mockClear();
    render(<ProjectSetupPage projectId={PID} projectName="owed-demo" />);
    await user.click(await screen.findByTestId('project-setup-rerun'));
    await waitFor(() => expect(start).toHaveBeenCalledWith(PID, ''));
  });

  it('Back goes to Project home by URL', async () => {
    render(<ProjectSetupPage projectId={PID} projectName="owed-demo" />);
    await userEvent.setup().click(screen.getByTestId('project-setup-back'));
    expect(String(openDock.mock.calls[0][0].pointer)).toBe(PID);
  });
});
