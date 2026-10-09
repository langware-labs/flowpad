/**
 * The project setup wizard, drawn in the app. The run is the backend's; this screen starts it,
 * claims its questions and draws each one in place — a key file as a file picker.
 */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), openDock: vi.fn() }));
vi.mock('@sdk/client', () => ({ default: { get: h.get, post: h.post } }));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openDock: h.openDock }, currentDock: null }),
}));

import { Project, type ProjectReadiness, type ProjectSetupRequirement } from '@sdk/entities/project';
import { ProjectSetupDialog, pointerForRequirement } from '@src/components/project-setup/ProjectSetupDialog';

const GCP_TYPEID = 'credential-6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f';

const RUN = 'wizard-project-setup-p1';
const NOT_READY: ProjectReadiness = {
  project_id: 'p1',
  ready: false,
  to_do: [
    {
      kind: 'pack',
      name: 'google-cloud',
      title: 'Google Cloud',
      typeid: GCP_TYPEID,
      used_by: ['project'],
      note: '',
      required: true,
      skipped: null,
      can_skip_always: true,
      why_not_always: '',
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
  h.openDock.mockReset();
});

/** The dialog over ``readiness``, with no run going. */
async function open(readiness: ProjectReadiness, onOpenChange = vi.fn()) {
  vi.spyOn(Project, 'setupRequirements').mockResolvedValue(readiness);
  vi.spyOn(Project, 'setupRun').mockResolvedValue({ run: RUN, running: false, tree: null });
  render(<ProjectSetupDialog projectId="p1" projectName="spora" open onOpenChange={onOpenChange} />);
  await screen.findByTestId('project-setup-requirements');
  return onOpenChange;
}

const req = (over: Partial<ProjectSetupRequirement>): ProjectSetupRequirement => ({
  ...NOT_READY.to_do[0],
  ...over,
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


describe('ProjectSetupDialog — skipping', () => {
  it('Skip opens Locally | Always | Cancel; Locally marks it here and the dialog takes the readiness that follows', async () => {
    await open(NOT_READY);
    const after: ProjectReadiness = {
      ...NOT_READY, ready: true, to_do: [],
      skipped: [req({ skipped: { at: 1, by: 'u1', note: '' } })],
    };
    const skip = vi.spyOn(Project, 'skipSetup').mockResolvedValue(after);

    fireEvent.click(screen.getByTestId('project-setup-skip-google-cloud'));
    expect(screen.getByTestId('project-setup-skip-choice-google-cloud')).toBeInTheDocument();
    await act(async () => fireEvent.click(screen.getByTestId('project-setup-skip-local-google-cloud')));

    expect(skip).toHaveBeenCalledWith('p1', GCP_TYPEID, 'local', { name: 'google-cloud' });
    const skipped = await screen.findByTestId('project-setup-skipped');
    expect(skipped).toHaveTextContent('required — it will not work here until it is set up');
    expect(screen.getByTestId('project-setup-undo-google-cloud')).toBeInTheDocument();
    expect(h.openDock).not.toHaveBeenCalled(); // a button in the row is not the row's link
  });

  it('Always is offered only for the project\'s own asset, and says why not', async () => {
    await open({ ...NOT_READY, to_do: [req({ can_skip_always: false, why_not_always: 'needed by drive — remove it first' })] });
    fireEvent.click(screen.getByTestId('project-setup-skip-google-cloud'));

    expect(screen.getByTestId('project-setup-skip-always-google-cloud')).toBeDisabled();
    expect(screen.getByTestId('project-setup-why-not-always-google-cloud')).toHaveTextContent('needed by drive');
  });

  it('Always removes it from the project', async () => {
    await open(NOT_READY);
    const skip = vi.spyOn(Project, 'skipSetup').mockResolvedValue({ ...NOT_READY, ready: true, to_do: [] });
    fireEvent.click(screen.getByTestId('project-setup-skip-google-cloud'));
    await act(async () => fireEvent.click(screen.getByTestId('project-setup-skip-always-google-cloud')));
    expect(skip).toHaveBeenCalledWith('p1', GCP_TYPEID, 'always', { name: 'google-cloud' });
  });

  it('Cancel closes the choice and changes nothing', async () => {
    await open(NOT_READY);
    const skip = vi.spyOn(Project, 'skipSetup');
    fireEvent.click(screen.getByTestId('project-setup-skip-google-cloud'));
    fireEvent.click(screen.getByTestId('project-setup-skip-cancel-google-cloud'));
    expect(screen.queryByTestId('project-setup-skip-choice-google-cloud')).toBeNull();
    expect(skip).not.toHaveBeenCalled();
  });

  it('Undo un-skips it', async () => {
    const mark = { at: 1, by: 'u1', note: '' };
    await open({ ...NOT_READY, to_do: [], ready: true, skipped: [req({ skipped: mark })] });
    const unskip = vi.spyOn(Project, 'unskipSetup').mockResolvedValue(NOT_READY);
    await act(async () => fireEvent.click(screen.getByTestId('project-setup-undo-google-cloud')));
    expect(unskip).toHaveBeenCalledWith('p1', GCP_TYPEID, 'google-cloud');
  });

  it('lists optional requirements in their own section', async () => {
    await open({ ...NOT_READY, optional: [req({ name: 'hue', title: 'Hue', required: false })] });
    expect(screen.getByTestId('project-setup-optional')).toHaveTextContent('Hue');
  });
});

describe('ProjectSetupDialog — a row opens its page with it selected', () => {
  it('a credential row opens the credentials page selecting it, and closes the dialog', async () => {
    const onOpenChange = await open(NOT_READY);
    fireEvent.click(screen.getByTestId('project-setup-req-google-cloud'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    const pointer = h.openDock.mock.calls[0][0];
    expect(pointer.viewType).toBe('credentials');
    expect(pointer.pointer).toBe(`connections/p1/${GCP_TYPEID}`);
  });

  it('Enter on a focused row opens it too', async () => {
    await open(NOT_READY);
    fireEvent.keyDown(screen.getByTestId('project-setup-req-google-cloud'), { key: 'Enter' });
    expect(h.openDock).toHaveBeenCalledTimes(1);
  });

  it('points each kind at its own page', () => {
    const SOURCE = 'data_source-7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
    const APP = 'micro_app-8b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e';
    expect(pointerForRequirement(req({ credential_kind: 'oauth' }), 'p1')?.pointer).toBe(`connections/p1/${GCP_TYPEID}`);
    expect(pointerForRequirement(req({ kind: 'source', typeid: SOURCE }), 'p1')?.pointer).toBe(SOURCE.slice('data_source-'.length));
    const app = pointerForRequirement(req({ kind: 'webapp', typeid: APP }), 'p1');
    expect([app?.viewType, app?.pointer]).toEqual(['app', APP]);
    expect(pointerForRequirement(req({ kind: 'dependency' }), 'p1')?.viewType).toBe('project');
  });
});
