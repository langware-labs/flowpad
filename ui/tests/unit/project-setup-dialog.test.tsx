/**
 * The project setup wizard, drawn in the app. The run is the backend's; this screen starts it,
 * claims its questions and draws each one in place — a key file as a file picker.
 */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@sdk/client', () => ({ default: { get: h.get, post: h.post } }));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openDock: vi.fn() }, currentDock: null }),
}));

import { Project, type ProjectReadiness } from '@sdk/entities/project';
import { ProjectSetupDialog } from '@src/components/project-setup/ProjectSetupDialog';

const RUN = 'wizard-project-setup-p1';
const NOT_READY: ProjectReadiness = {
  project_id: 'p1',
  ready: false,
  to_do: [
    {
      kind: 'pack',
      name: 'google-cloud',
      title: 'Google Cloud',
      used_by: ['project'],
      note: '',
      vars: [
        { env_var: 'GOOGLE_APPLICATION_CREDENTIALS', label: 'Service account key', hint: '', help_url: '', pattern: '', secret: true, file: true, present: false },
      ],
    },
  ],
  gaps: [],
};
const QUESTION = {
  id: 'q1', op: 'ask-google-cloud', prompt: 'Google Cloud: Service account key', fields: 'string',
  secret: true, file: true, run: RUN,
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  h.get.mockReset();
  h.post.mockReset();
});

describe('ProjectSetupDialog', () => {
  it('lists what is left, starts the run, and draws its question in place as a file block', async () => {
    vi.spyOn(Project, 'setupRequirements').mockResolvedValue(NOT_READY);
    const start = vi.spyOn(Project, 'startSetup').mockResolvedValue(RUN);
    // Nothing going when the dialog opens; the run is going once Start is pressed.
    vi.spyOn(Project, 'setupRun')
      .mockResolvedValueOnce({ run: RUN, running: false, tree: null })
      .mockResolvedValue({ run: RUN, running: true, tree: null });
    h.get.mockImplementation(async (path: string) =>
      path === '/api/v1/ask' ? { questions: [{ id: 'q1', run: RUN }] } : path === '/api/v1/ask/q1' ? QUESTION : null,
    );

    render(<ProjectSetupDialog projectId="p1" projectName="spora" open onOpenChange={() => undefined} />);

    expect(await screen.findByTestId('project-setup-req-google-cloud')).toHaveTextContent('Service account key');
    await act(async () => fireEvent.click(screen.getByTestId('project-setup-start')));

    expect(start).toHaveBeenCalledWith('p1', '');
    await waitFor(() => expect(screen.getByTestId('ask-input-value-file')).toBeInTheDocument());
  });

  it('says so when there is nothing to set up', async () => {
    vi.spyOn(Project, 'setupRequirements').mockResolvedValue({ ...NOT_READY, ready: true, to_do: [] });

    render(<ProjectSetupDialog projectId="p1" projectName="spora" open onOpenChange={() => undefined} />);

    expect(await screen.findByTestId('project-setup-ready')).toBeInTheDocument();
    expect(screen.queryByTestId('project-setup-start')).toBeNull();
  });
});
