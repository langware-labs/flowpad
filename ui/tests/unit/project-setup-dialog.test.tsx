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
        {
          env_var: 'GOOGLE_APPLICATION_CREDENTIALS',
          label: 'Service account key',
          hint: '',
          help_url: '',
          pattern: '',
          secret: true,
          file: true,
          present: false,
        },
      ],
    },
  ],
  gaps: [],
};
const QUESTION = {
  id: 'q1',
  op: 'ask-google-cloud',
  prompt: 'Google Cloud: Service account key',
  fields: 'string',
  secret: true,
  file: true,
  run: RUN,
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
  render(<ProjectSetupDialog projectId="p1" projectName="acme" open onOpenChange={onOpenChange} />);
  // Until ``readiness`` has been drawn, not until the dialog is up: the Required list is there (empty)
  // before the requirements arrive, so waiting for it alone returns ahead of the data on a slow render.
  await waitFor(() => {
    if (readiness.ready) expect(screen.getByTestId('project-setup-ready')).toBeInTheDocument();
    else expect(screen.getByTestId('project-setup-requirements').children).toHaveLength(readiness.to_do.length);
    if (readiness.optional?.length) expect(screen.getByTestId('project-setup-optional')).toBeInTheDocument();
    if (readiness.skipped?.length) expect(screen.getByTestId('project-setup-skipped')).toBeInTheDocument();
  });
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

    render(<ProjectSetupDialog projectId="p1" projectName="acme" open onOpenChange={() => undefined} />);

    expect(await screen.findByTestId('project-setup-req-google-cloud')).toHaveTextContent('Service account key');
    await act(async () => fireEvent.click(screen.getByTestId('project-setup-start')));

    expect(start).toHaveBeenCalledWith('p1', '');
    await waitFor(() => expect(screen.getByTestId('ask-input-value-file')).toBeInTheDocument());
  });

  it('says so when there is nothing to set up', async () => {
    vi.spyOn(Project, 'setupRequirements').mockResolvedValue({ ...NOT_READY, ready: true, to_do: [] });

    render(<ProjectSetupDialog projectId="p1" projectName="acme" open onOpenChange={() => undefined} />);

    expect(await screen.findByTestId('project-setup-ready')).toBeInTheDocument();
    expect(screen.queryByTestId('project-setup-start')).toBeNull();
  });
});

describe('ProjectSetupDialog — skipping', () => {
  it('Skip is one click: it skips on this machine and the dialog takes the readiness that follows', async () => {
    await open(NOT_READY);
    const after: ProjectReadiness = {
      ...NOT_READY,
      ready: true,
      to_do: [],
      skipped: [req({ skipped: { at: 1, by: 'u1', note: '' } })],
    };
    const skip = vi.spyOn(Project, 'skipSetup').mockResolvedValue(after);

    fireEvent.click(screen.getByTestId('project-setup-skip-google-cloud'));
    // The row's Skip opens the same bar as a selection: Locally | Always | Cancel.
    expect(screen.getByTestId('project-setup-selection-bar')).toHaveTextContent('1 selected');
    expect(screen.getByTestId('project-setup-skip-always-selected')).toBeInTheDocument();
    await act(async () => fireEvent.click(screen.getByTestId('project-setup-skip-local-selected')));

    expect(skip).toHaveBeenCalledWith('p1', GCP_TYPEID, 'local', { name: 'google-cloud' });
    const skipped = await screen.findByTestId('project-setup-skipped');
    expect(skipped).toHaveTextContent('Required — skipped on this machine');
    expect(screen.queryByTestId('project-setup-chip-google-cloud')).toBeNull();
    expect(screen.getByTestId('project-setup-undo-google-cloud')).toBeInTheDocument();
    expect(h.openDock).not.toHaveBeenCalled(); // a button in the row is not the row's link
  });

  it("checking rows hides each row's Skip and shows one bar that skips them all, then selects none", async () => {
    const mapbox = req({
      name: 'mapbox',
      title: 'Mapbox',
      typeid: 'credential-7f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f',
      required: false,
    });
    await open({ ...NOT_READY, optional: [mapbox] });
    const skip = vi.spyOn(Project, 'skipSetup').mockResolvedValue({ ...NOT_READY, optional: [mapbox] });
    expect(screen.queryByTestId('project-setup-selection-bar')).toBeNull();
    fireEvent.click(screen.getByTestId('project-setup-select-google-cloud'));
    fireEvent.click(screen.getByTestId('project-setup-select-mapbox'));
    expect(screen.getByTestId('project-setup-selection-bar')).toHaveTextContent('2 selected');
    expect(screen.queryByTestId('project-setup-skip-google-cloud')).toBeNull();
    expect(screen.queryByTestId('project-setup-skip-mapbox')).toBeNull();
    await act(async () => fireEvent.click(screen.getByTestId('project-setup-skip-local-selected')));
    expect(skip.mock.calls).toEqual([
      ['p1', GCP_TYPEID, 'local', { name: 'google-cloud' }],
      ['p1', mapbox.typeid, 'local', { name: 'mapbox' }],
    ]);
    expect(screen.queryByTestId('project-setup-selection-bar')).toBeNull();
    expect(screen.getByTestId('project-setup-skip-google-cloud')).toBeInTheDocument();
    expect(h.openDock).not.toHaveBeenCalled();
  });

  it('the bar offers Always only when every selected row can be removed, and Cancel selects none', async () => {
    await open({ ...NOT_READY, to_do: [req({ can_skip_always: false })] });
    fireEvent.click(screen.getByTestId('project-setup-select-google-cloud'));
    expect(screen.getByTestId('project-setup-skip-always-selected')).toBeDisabled();
    fireEvent.click(screen.getByTestId('project-setup-skip-cancel-selected'));
    expect(screen.queryByTestId('project-setup-selection-bar')).toBeNull();
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

describe('ProjectSetupDialog — a credential says what it is needed for', () => {
  it('names an either-or group of missing values as "A or B", the rest by commas', async () => {
    const [key] = NOT_READY.to_do[0].vars;
    await open({
      ...NOT_READY,
      to_do: [
        req({
          vars: [
            {
              ...key,
              env_var: 'GCP_PROJECT',
              label: 'Project',
              file: false,
              required: 'MUST',
              kind: 'text',
              login: '',
            },
            { ...key, required: 'ONE_OF', kind: 'file', login: '' },
            {
              ...key,
              env_var: 'GCLOUD_ADC',
              label: 'gcloud sign-in',
              file: false,
              required: 'ONE_OF',
              kind: 'cli',
              login: 'gcloud auth application-default login',
            },
          ],
        }),
      ],
    });
    expect(screen.getByTestId('project-setup-req-google-cloud')).toHaveTextContent(
      'Project, Service account key or gcloud sign-in',
    );
  });

  it('a group with one member present is not missing', async () => {
    const [key] = NOT_READY.to_do[0].vars;
    await open({
      ...NOT_READY,
      to_do: [
        req({
          vars: [
            { ...key, env_var: 'GCP_PROJECT', label: 'Project', file: false, required: 'MUST' },
            { ...key, required: 'ONE_OF' },
            {
              ...key,
              env_var: 'GCLOUD_ADC',
              label: 'gcloud sign-in',
              file: false,
              required: 'ONE_OF',
              kind: 'cli',
              present: true,
            },
          ],
        }),
      ],
    });
    const row = screen.getByTestId('project-setup-req-google-cloud');
    expect(row).toHaveTextContent('Project');
    expect(row).not.toHaveTextContent('Service account key');
  });

  it('shows needed_for beside the name, in place of the missing values', async () => {
    await open({ ...NOT_READY, to_do: [req({ needed_for: 'Reads the files in your bucket.' })] });
    const row = screen.getByTestId('project-setup-req-google-cloud');
    expect(row).toHaveTextContent('Reads the files in your bucket.');
    expect(row).not.toHaveTextContent('Service account key');
  });

  it('offers the info icon only with a justification, and it opens the reason without opening the row', async () => {
    await open(NOT_READY);
    expect(screen.queryByTestId('project-setup-why-google-cloud')).toBeNull();
    cleanup();

    const onOpenChange = await open({
      ...NOT_READY,
      to_do: [
        req({
          needed_for: 'Reads the files in your bucket.',
          justification: 'The sync job lists the bucket every hour.',
        }),
      ],
    });
    fireEvent.click(screen.getByTestId('project-setup-why-google-cloud'));
    expect(await screen.findByTestId('project-setup-why-text-google-cloud')).toHaveTextContent(
      'The sync job lists the bucket every hour.',
    );
    expect(h.openDock).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
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
    expect(pointerForRequirement(req({ credential_kind: 'oauth' }), 'p1')?.pointer).toBe(
      `connections/p1/${GCP_TYPEID}`,
    );
    expect(pointerForRequirement(req({ kind: 'source', typeid: SOURCE }), 'p1')?.pointer).toBe(
      SOURCE.slice('data_source-'.length),
    );
    const app = pointerForRequirement(req({ kind: 'webapp', typeid: APP }), 'p1');
    expect([app?.viewType, app?.pointer]).toEqual(['app', APP]);
    expect(pointerForRequirement(req({ kind: 'dependency' }), 'p1')?.viewType).toBe('project');
  });
});

describe('ProjectSetupDialog — controlling a run', () => {
  const node = (id: string, state: string, children: unknown[] = []) => ({
    id,
    label: id.toUpperCase(),
    level: 0,
    state,
    detail: '',
    prepare: null,
    run: null,
    children,
    shared: false,
  });
  const tree = (state: string, child: string) =>
    ({
      state,
      detail: '',
      root: node('project-p1', state, [node('credential:gmail', child)]),
      total: 2,
      done: 0,
    }) as never;

  it('while running: one status line with what it is on and Stop; rows can still be skipped', async () => {
    vi.spyOn(Project, 'setupRequirements').mockResolvedValue(NOT_READY);
    vi.spyOn(Project, 'setupRun').mockResolvedValue({ run: RUN, running: true, tree: tree('running', 'running') });
    h.get.mockResolvedValue(null);
    const stop = vi.spyOn(Project, 'stopSetup').mockResolvedValue(true);

    render(<ProjectSetupDialog projectId="p1" projectName="acme" open onOpenChange={() => undefined} />);

    const status = await screen.findByTestId('project-setup-status');
    await waitFor(() => expect(status).toHaveTextContent('Setting up CREDENTIAL:GMAIL'));
    // The same count as the list under it: the one row drawn, not the run's two nodes (the root is hidden).
    expect(status).toHaveTextContent('· 0 / 1');
    expect(screen.getByTestId('setup-tree-progress')).toHaveTextContent('0 of 1 set up');
    expect(screen.getByTestId('project-setup-skip-google-cloud')).toBeInTheDocument();
    expect(screen.getByTestId('project-setup-select-google-cloud')).toBeInTheDocument();
    await act(async () => fireEvent.click(screen.getByTestId('project-setup-stop')));
    expect(stop).toHaveBeenCalledWith('p1', '');
  });

  it('after a run that failed a step: says so and offers Retry; a stopped run offers Continue', async () => {
    vi.spyOn(Project, 'setupRequirements').mockResolvedValue(NOT_READY);
    const run = vi
      .spyOn(Project, 'setupRun')
      .mockResolvedValue({ run: RUN, running: false, tree: tree('failed', 'failed') });
    render(<ProjectSetupDialog projectId="p1" projectName="acme" open onOpenChange={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId('project-setup-start')).toHaveTextContent('Retry'));
    expect(screen.getByTestId('project-setup-status')).toHaveTextContent('1 did not finish');
    cleanup();

    run.mockResolvedValue({ run: RUN, running: false, tree: tree('stopped', 'stopped') });
    render(<ProjectSetupDialog projectId="p1" projectName="acme" open onOpenChange={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId('project-setup-status')).toHaveTextContent('Stopped'));
    expect(screen.getByTestId('project-setup-start')).toHaveTextContent('Continue');
  });
});

describe('ProjectSetupDialog — project requirements card', () => {
  const GMAIL = req({
    name: 'gmail',
    title: 'Gmail',
    required: false,
    used_by: ['data source Gmail'],
    needed_for: 'Reads your Gmail mail into conversations, every few minutes, from the address you sign in with.',
  });

  it('is titled for the project and says what it is for', async () => {
    await open(NOT_READY);
    expect(screen.getByText('Project requirements')).toBeInTheDocument();
    expect(screen.getByText('Needed to run acme on this computer.')).toBeInTheDocument();
  });

  it('each row says Required or Optional, why — whole — and who uses it', async () => {
    await open({ ...NOT_READY, optional: [GMAIL] });
    expect(screen.getByTestId('project-setup-chip-google-cloud')).toHaveTextContent('Required');
    expect(screen.getByTestId('project-setup-chip-gmail')).toHaveTextContent('Optional');
    const why = screen.getByTestId('project-setup-detail-gmail');
    expect(why).toHaveTextContent(GMAIL.needed_for!);
    expect(why.className).not.toContain('truncate');
    expect(screen.getByTestId('project-setup-used-by-gmail')).toHaveTextContent('Used by: data source Gmail');
  });

  it('a row has no Set up button of its own — Continue sets everything up, the row itself opens', async () => {
    await open({ ...NOT_READY, optional: [GMAIL] });
    expect(screen.queryByTestId('project-setup-open-gmail')).toBeNull();
    expect(screen.queryByTestId('project-setup-skip-choice-gmail')).toBeNull();
  });
});

describe('ProjectSetupDialog — one row id per requirement', () => {
  it('a credential and the data source of the same name get distinct ids', async () => {
    const source = req({
      kind: 'source',
      name: 'google-cloud',
      typeid: 'data_source-11111111-1111-4111-8111-111111111111',
      vars: [],
    });
    await open({ ...NOT_READY, to_do: [NOT_READY.to_do[0], source] });
    expect(screen.getByTestId('project-setup-req-google-cloud')).toBeInTheDocument();
    expect(screen.getByTestId('project-setup-req-source-google-cloud')).toBeInTheDocument();
  });
});
