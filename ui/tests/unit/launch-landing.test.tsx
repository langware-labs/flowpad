/**
 * `/launch` — the two things a link can name, and the one link it may not be.
 *
 * `?repo=` is the pre-existing "try this repo" flow and must not move. `?agent=` is its own page:
 * sign in, then straight into a sandbox running the agent's repository, and a redirect to the
 * machine once it is up. Every agent case is really about when that launch may start: never while
 * signed out, never before the agent's repository is known, and exactly once.
 *
 * Signed out, the page only makes a QUIET anonymous read (`apiClient.get`): a public agent answers
 * it and is named on the sign-in card; a private one is refused, which is expected and never shown. Signed in, `useEntity` is the seam for the hub
 * read, so each case states exactly what the hub answered.
 *
 * `useSandboxes` keeps its real `plannedSteps` / `workspaceServiceUrl` (only the launch calls are
 * stubbed).
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type EntityCall = { typeId: { type: string; id: string } | null; enabled: boolean | undefined };

const mocks = vi.hoisted(() => ({
  launch: vi.fn(),
  createSandbox: vi.fn(),
  launchSandbox: vi.fn(),
  /** The quiet signed-out agent read (`apiClient.get`). */
  anonGet: vi.fn(),
  /** The setup rows `useSandboxes` reports; the agent page's percentage is read off them. */
  steps: [] as { id: string; label: string; status: string }[],
  login: vi.fn(),
  /** How the sign-in popup ended: `signed-in`, `cancelled` or `blocked`. */
  loginPopup: vi.fn(),
  /** Whether a fresh look at the session finds someone signed in. */
  refreshSession: vi.fn(),
  provisionProject: vi.fn(),
  /** What `useAuth().currentUser` reports: truthy = signed in. */
  currentUser: null as unknown,
  /** What the hub read answers with, when the page is allowed to make it. */
  entity: {} as Record<string, unknown>,
  entityCalls: [] as EntityCall[],
  /** What the hub's `launch_info` answers, by `<kind>/<id>`. */
  launchInfo: {} as Record<string, unknown>,
  /** The signed-in user's projects (the controller's target picker). */
  projects: [] as unknown[],
  openInFlowpad: vi.fn(),
  openTargetPaths: [] as string[],
}));

vi.mock('@src/hooks/use-projects', () => ({
  useProjects: () => ({ projects: mocks.projects, isLoading: false, error: null, refetch: async () => {} }),
}));

vi.mock('@src/pages/entry/useOpenFlowpad', () => ({
  useOpenInFlowpad: (path: string) => {
    mocks.openTargetPaths.push(path);
    return () => mocks.openInFlowpad(path);
  },
}));

vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    cloudManager: {
      ...(actual.cloudManager as object),
      login: (opts: unknown) => mocks.login(opts),
      loginPopup: (opts: unknown) => mocks.loginPopup(opts),
    },
  };
});

vi.mock('@sdk/session-refresh', () => ({ refreshSession: () => mocks.refreshSession() }));

vi.mock('@sdk/react/hooks', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const idle = {
    data: null,
    isLoading: false,
    isFetching: false,
    isError: false,
    isSuccess: false,
    error: null,
    notFound: false,
    refetch: async () => {},
  };
  return {
    ...actual,
    useAuth: () => ({ currentUser: mocks.currentUser }),
    useEntity: (typeId: EntityCall['typeId'], options?: { enabled?: boolean }) => {
      mocks.entityCalls.push({ typeId, enabled: options?.enabled });
      // A disabled read never reaches the hub, so it answers nothing — whatever the hub would say.
      return options?.enabled && typeId ? { ...idle, ...mocks.entity } : idle;
    },
  };
});

vi.mock('@src/hooks/use-sandboxes', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    useSandboxes: () => ({
      launch: mocks.launch,
      createSandbox: (...args: unknown[]) => mocks.createSandbox(...args),
      launchSandbox: (...args: unknown[]) => mocks.launchSandbox(...args),
      provisionProject: (...args: unknown[]) => mocks.provisionProject(...args),
      steps: mocks.steps,
      launchUrl: null,
    }),
  };
});

const { gitOriginFromUrl, Project } = await import('@sdk');
const { launchPlanToPath } = await import('@src/pages/entry/launch-plan');
const { default: apiClient } = await import('@sdk/client');
const { workspaceServiceUrl } = await import('@src/hooks/use-sandboxes');
const { default: LaunchLanding } = await import('@src/pages/entry/LaunchLanding');

const INTENT_KEY = 'flowpad_launch_intent';
const REPO = 'https://github.com/acme/site';
// Real v4 ids: TypeId validates the shape, and a rejected id would take the bad-link exit instead.
const AGENT_ID = '11111111-2222-4333-8444-555555555555';
const NODE_ID = '99999999-8888-4777-8666-555555555555';

const publishedOrigin = {
  kind: 'git' as const,
  provider: 'github',
  owner: 'acme',
  name: 'agents',
  branch: 'flow-cloud',
  head_commit: 'a'.repeat(40),
  rel_path: 'agentic-assets/agent/q',
};

const agentRow = (over: Record<string, unknown> = {}) => ({
  id: AGENT_ID,
  name: 'q',
  title: 'Q the helper',
  git_origin: publishedOrigin,
  ...over,
});

/** How the hub refuses an anonymous read of a private agent. */
const privateRefusal = () =>
  Object.assign(new Error('Request failed with status code 401'), { response: { status: 401 } });

const answered = (over: Record<string, unknown>) => ({
  data: null,
  isLoading: false,
  isError: false,
  error: null,
  notFound: false,
  ...over,
});

/** The reads the page was ALLOWED to make — a disabled `useEntity` call is not a read. */
const hubReads = () => mocks.entityCalls.filter((c) => c.enabled);

const settle = () => new Promise((r) => setTimeout(r, 20));

function renderLanding(query: string) {
  return render(
    <MemoryRouter initialEntries={[`/launch${query}`]}>
      <Routes>
        <Route path="launch" element={<LaunchLanding />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mocks.launch = vi.fn();
  mocks.createSandbox = vi.fn().mockResolvedValue({ id: NODE_ID });
  mocks.launchSandbox = vi.fn().mockResolvedValue({ id: NODE_ID });
  mocks.anonGet = vi.fn().mockRejectedValue(privateRefusal());
  mocks.steps = [];
  mocks.login = vi.fn();
  mocks.loginPopup = vi.fn().mockResolvedValue('signed-in');
  mocks.refreshSession = vi.fn().mockResolvedValue(false);
  mocks.provisionProject = vi.fn().mockResolvedValue({ id: NODE_ID });
  mocks.currentUser = { id: 'user-1', email: 'me@acme.test' };
  mocks.entity = answered({});
  mocks.entityCalls = [];
  mocks.launchInfo = {};
  mocks.projects = [];
  mocks.openInFlowpad = vi.fn().mockResolvedValue(true);
  mocks.openTargetPaths = [];
  vi.spyOn(apiClient, 'get').mockImplementation((...args: unknown[]) => {
    const url = String(args[0]);
    const info = url.match(/\/api\/v1\/graph\/(agent|project)\/([^/]+)\/launch_info$/);
    if (info) {
      const answer = mocks.launchInfo[`${info[1]}/${info[2]}`];
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer ?? null);
    }
    return mocks.anonGet(...args);
  });
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  sessionStorage.clear();
});

describe('/launch?repo= — unchanged', () => {
  it('shows the repository and launches it from the approve click', () => {
    renderLanding(`?repo=${REPO}`);

    expect(screen.getByTestId('launch-repo').textContent).toContain('acme/site');
    fireEvent.click(screen.getByTestId('launch-approve'));

    expect(mocks.launch).toHaveBeenCalledWith({
      name: 'site',
      sandboxProject: { gitOrigin: gitOriginFromUrl(REPO, ''), name: 'site' },
    });
    // A repo link never asks the hub about an agent.
    expect(hubReads()).toHaveLength(0);
    expect(mocks.anonGet).not.toHaveBeenCalled();
  });

  it('resumes the launch approved before sign-in, for the same link', async () => {
    sessionStorage.setItem(INTENT_KEY, JSON.stringify({ repo: REPO, branch: '', agent: '' }));

    renderLanding(`?repo=${REPO}`);

    await waitFor(() => expect(mocks.launch).toHaveBeenCalledTimes(1));
  });

  it('does not spend an approval recorded for a different repository', async () => {
    sessionStorage.setItem(
      INTENT_KEY,
      JSON.stringify({ repo: 'https://github.com/acme/other', branch: '', agent: '' }),
    );

    renderLanding(`?repo=${REPO}`);
    await settle();

    expect(mocks.launch).not.toHaveBeenCalled();
  });
});

describe('/launch with both repo and agent', () => {
  it('refuses the link: nothing is read, nothing can be approved', () => {
    renderLanding(`?repo=${REPO}&agent=${AGENT_ID}`);

    expect(screen.getByTestId('launch-invalid-link').textContent).toContain('more than one thing to launch');
    expect(screen.queryByTestId('launch-approve')).toBeNull();
    expect(screen.queryByTestId('launch-repo')).toBeNull();
    expect(hubReads()).toHaveLength(0);
    expect(mocks.launch).not.toHaveBeenCalled();
  });
});

describe('/launch?agent= and ?project=', () => {
  const originalLocation = window.location;
  let assign: ReturnType<typeof vi.fn>;

  const AGENT_PROJECT = '22222222-3333-4444-8555-666666666666';
  const TARGET_PROJECT = '33333333-4444-4555-8666-777777777777';
  const hubRepo = (repo: string) => ({ kind: 'hub_repo', repo, rel_path: '.', head_commit: null, tree: null });

  /** A standard project's agent: it launches in its own project. */
  const standardInfo = {
    project_id: AGENT_PROJECT,
    project_name: 'site-bot',
    origin: hubRepo('git_repo-aaaa'),
    subkind: 'standard',
    home_page: null,
    agent_id: AGENT_ID,
  };
  /** A controller's agent (Q): it needs a target picked. */
  const controllerInfo = { ...standardInfo, project_name: 'q-agent-test', subkind: 'controller' };
  const spora = new Project({ id: TARGET_PROJECT, name: 'spora', git_origin: hubRepo('git_repo-bbbb') });

  beforeEach(() => {
    // jsdom's real `location.assign` is unimplemented; swap it for a spy.
    assign = vi.fn();
    delete (window as unknown as { location?: Location }).location;
    (window as unknown as { location: Partial<Location> }).location = {
      origin: originalLocation.origin,
      href: originalLocation.href,
      assign,
    };
  });

  afterEach(() => {
    (window as unknown as { location: Location }).location = originalLocation;
  });

  it('signed out, private agent: generic sign-in line, asks the hub nothing about the launch', async () => {
    mocks.currentUser = null;
    vi.spyOn(console, 'log').mockImplementation(() => {});

    renderLanding(`?agent=${AGENT_ID}`);

    expect(screen.getByTestId('launch-sign-in-title').textContent).toBe('Please sign in to flowpad to continue.');
    await waitFor(() => expect(mocks.anonGet).toHaveBeenCalledWith(`/api/v1/graph/agent/${AGENT_ID}`));
    expect(screen.queryByTestId('launch-choice')).toBeNull();
    fireEvent.click(screen.getByTestId('launch-sign-in'));
    expect(mocks.loginPopup).toHaveBeenCalledWith({ refresh: 'session' });
  });

  it('a sign-in window that was closed says so, and can be tried again', async () => {
    mocks.currentUser = null;
    mocks.loginPopup = vi.fn().mockResolvedValue('cancelled');
    vi.spyOn(console, 'log').mockImplementation(() => {});

    renderLanding(`?agent=${AGENT_ID}`);
    fireEvent.click(screen.getByTestId('launch-sign-in'));

    await waitFor(() => expect(screen.getByTestId('launch-sign-in-dropped').textContent).toContain("wasn't completed"));
    // The session was asked first: a sign-in that went through elsewhere is not called a cancel.
    expect(mocks.refreshSession).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('launch-sign-in')).toBeTruthy();
  });

  it('with no popup to be had, signs in on the full page instead', async () => {
    mocks.currentUser = null;
    mocks.loginPopup = vi.fn().mockResolvedValue('blocked');
    vi.spyOn(console, 'log').mockImplementation(() => {});

    renderLanding(`?agent=${AGENT_ID}`);
    fireEvent.click(screen.getByTestId('launch-sign-in'));

    await waitFor(() => expect(mocks.login).toHaveBeenCalledWith({ popup: false }));
  });

  it('signed out, public agent: names it on the sign-in card', async () => {
    mocks.currentUser = null;
    mocks.anonGet = vi.fn().mockResolvedValue(agentRow());

    renderLanding(`?agent=${AGENT_ID}`);

    await waitFor(() => expect(screen.getByTestId('launch-sign-in-title').textContent).toContain('Q the helper'));
    expect(mocks.createSandbox).not.toHaveBeenCalled();
  });

  it('a standard agent launches in its own project: no picker, nothing starts before a click', async () => {
    mocks.launchInfo = { [`agent/${AGENT_ID}`]: standardInfo };

    renderLanding(`?agent=${AGENT_ID}`);

    await waitFor(() => expect(screen.getByTestId('launch-title').textContent).toBe('Launch site-bot'));
    expect(screen.queryByTestId('launch-target-picker')).toBeNull();
    await settle();
    expect(mocks.createSandbox).not.toHaveBeenCalled();
    expect(mocks.openInFlowpad).not.toHaveBeenCalled();
  });

  it('desktop: hands the machine the launch path — target and face, nothing else', async () => {
    mocks.launchInfo = { [`agent/${AGENT_ID}`]: standardInfo };

    renderLanding(`?agent=${AGENT_ID}`);
    await waitFor(() => expect(screen.getByTestId('launch-desktop')).toBeTruthy());
    fireEvent.click(screen.getByTestId('launch-desktop'));

    const path = launchPlanToPath({ target: { projectId: AGENT_PROJECT }, agentId: AGENT_ID });
    await waitFor(() => expect(mocks.openInFlowpad).toHaveBeenCalledWith(path));
    expect(mocks.createSandbox).not.toHaveBeenCalled();
  });

  it('cloud: provisions the project, then opens the box on the launch path in this tab', async () => {
    mocks.launchInfo = { [`agent/${AGENT_ID}`]: standardInfo };

    renderLanding(`?agent=${AGENT_ID}`);
    await waitFor(() => expect(screen.getByTestId('launch-cloud')).toBeTruthy());
    fireEvent.click(screen.getByTestId('launch-cloud'));

    const sandboxProject = { name: 'site-bot', gitOrigin: standardInfo.origin, projectId: AGENT_PROJECT };
    await waitFor(() => expect(assign).toHaveBeenCalled());
    expect(mocks.createSandbox).toHaveBeenCalledWith({ name: 'site-bot', sandboxProject });
    expect(mocks.launchSandbox).toHaveBeenCalledWith({ id: NODE_ID }, { sandboxProject });
    const path = launchPlanToPath({ target: { projectId: AGENT_PROJECT }, agentId: AGENT_ID });
    expect(assign).toHaveBeenCalledWith(workspaceServiceUrl(NODE_ID, path));
  });

  it('a controller asks for a target first, and launches nothing until one is picked', async () => {
    mocks.launchInfo = { [`agent/${AGENT_ID}`]: controllerInfo };
    mocks.projects = [spora, new Project({ id: AGENT_PROJECT, name: 'q-agent-test', git_origin: hubRepo('x') })];

    renderLanding(`?agent=${AGENT_ID}`);

    await waitFor(() => expect(screen.getByTestId('launch-target-picker')).toBeTruthy());
    const options = [...screen.getByTestId('launch-target-select').querySelectorAll('option')].map((o) => o.value);
    // The controller is never offered as its own target.
    expect(options).toEqual(['', TARGET_PROJECT]);
    expect(screen.getByTestId('launch-cloud').disabled).toBe(true);
    expect(screen.getByTestId('launch-desktop').disabled).toBe(true);
  });

  it('a controller on a picked project: the box gets the target, and the controller BESIDE it', async () => {
    mocks.launchInfo = { [`agent/${AGENT_ID}`]: controllerInfo };
    mocks.projects = [spora];

    renderLanding(`?agent=${AGENT_ID}`);
    await waitFor(() => expect(screen.getByTestId('launch-target-select')).toBeTruthy());
    fireEvent.change(screen.getByTestId('launch-target-select'), { target: { value: TARGET_PROJECT } });
    fireEvent.click(screen.getByTestId('launch-cloud'));

    await waitFor(() => expect(assign).toHaveBeenCalled());
    expect(mocks.createSandbox).toHaveBeenCalledWith({
      name: 'spora',
      sandboxProject: {
        name: 'spora',
        gitOrigin: hubRepo('git_repo-bbbb'),
        projectId: TARGET_PROJECT,
        companions: [{ gitOrigin: controllerInfo.origin, name: 'q-agent-test', projectId: AGENT_PROJECT }],
      },
    });
    const path = launchPlanToPath({
      target: { projectId: TARGET_PROJECT },
      controllerId: AGENT_PROJECT,
      agentId: AGENT_ID,
    });
    expect(assign).toHaveBeenCalledWith(workspaceServiceUrl(NODE_ID, path));
  });

  it('a controller on a repository URL: the desktop gets a repo target', async () => {
    mocks.launchInfo = { [`agent/${AGENT_ID}`]: controllerInfo };

    renderLanding(`?agent=${AGENT_ID}`);
    await waitFor(() => expect(screen.getByTestId('launch-target-repo')).toBeTruthy());
    fireEvent.change(screen.getByTestId('launch-target-repo'), { target: { value: REPO } });
    fireEvent.click(screen.getByTestId('launch-desktop'));

    const path = launchPlanToPath({ target: { repo: REPO }, controllerId: AGENT_PROJECT, agentId: AGENT_ID });
    await waitFor(() => expect(mocks.openInFlowpad).toHaveBeenCalledWith(path));
  });

  it('a project link launches the project with no face named — its home page decides', async () => {
    mocks.launchInfo = { [`project/${AGENT_PROJECT}`]: { ...standardInfo, agent_id: null } };

    renderLanding(`?project=${AGENT_PROJECT}`);
    await waitFor(() => expect(screen.getByTestId('launch-desktop')).toBeTruthy());
    fireEvent.click(screen.getByTestId('launch-desktop'));

    await waitFor(() =>
      expect(mocks.openInFlowpad).toHaveBeenCalledWith(launchPlanToPath({ target: { projectId: AGENT_PROJECT } })),
    );
  });

  it('launches in the cloud exactly once, however often it is clicked', async () => {
    mocks.launchInfo = { [`agent/${AGENT_ID}`]: standardInfo };
    let finish: (node: unknown) => void = () => {};
    mocks.launchSandbox = vi.fn().mockReturnValue(new Promise((r) => (finish = r)));

    renderLanding(`?agent=${AGENT_ID}`);
    await waitFor(() => expect(screen.getByTestId('launch-cloud')).toBeTruthy());
    fireEvent.click(screen.getByTestId('launch-cloud'));
    fireEvent.click(screen.getByTestId('launch-cloud'));
    finish({ id: NODE_ID });

    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    expect(mocks.createSandbox).toHaveBeenCalledTimes(1);
  });

  it('shows setup progress as the share of finished steps while the sandbox comes up', async () => {
    mocks.launchInfo = { [`agent/${AGENT_ID}`]: standardInfo };
    mocks.launchSandbox = vi.fn().mockReturnValue(new Promise(() => {}));
    mocks.steps = [
      { id: 'launch', label: 'l', status: 'success' },
      { id: 'health', label: 'h', status: 'loading' },
      { id: 'clone', label: 'c', status: 'idle' },
      { id: 'open', label: 'o', status: 'idle' },
    ];

    renderLanding(`?agent=${AGENT_ID}`);
    await waitFor(() => expect(screen.getByTestId('launch-cloud')).toBeTruthy());
    fireEvent.click(screen.getByTestId('launch-cloud'));

    await waitFor(() => expect(screen.getByTestId('launch-percent').textContent).toBe('25%'));
  });

  it('a setup that fails keeps its steps on screen, and trying again carries on with the same sandbox', async () => {
    mocks.launchInfo = { [`agent/${AGENT_ID}`]: standardInfo };
    mocks.launchSandbox = vi.fn().mockRejectedValue(new Error('could not clone the project repository'));
    mocks.steps = [
      { id: 'launch', label: 'Starting the sandbox', status: 'success' },
      { id: 'health', label: 'Starting FlowPad', status: 'success' },
      { id: 'clone', label: 'Cloning the repository', status: 'error' },
    ];

    renderLanding(`?agent=${AGENT_ID}`);
    await waitFor(() => expect(screen.getByTestId('launch-cloud')).toBeTruthy());
    fireEvent.click(screen.getByTestId('launch-cloud'));

    await waitFor(() => expect(screen.getByTestId('launch-failed').textContent).toContain('could not clone'));
    expect(assign).not.toHaveBeenCalled();
    expect(screen.getByTestId('launch-step-clone').getAttribute('data-status')).toBe('error');
    // The machine is up: it can be opened as it is, and the retry redoes only the project work on it.
    expect(screen.getByTestId('launch-open-sandbox').getAttribute('href')).toBe(workspaceServiceUrl(NODE_ID));
    fireEvent.click(screen.getByTestId('launch-cloud-retry'));

    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    expect(mocks.createSandbox).toHaveBeenCalledTimes(1);
    expect(mocks.provisionProject).toHaveBeenCalledWith({ id: NODE_ID });
    expect(mocks.launchSandbox).toHaveBeenCalledTimes(1);
  });

  it('a clone git could not authenticate is said in plain words, not as a terminal prompt', async () => {
    mocks.launchInfo = { [`agent/${AGENT_ID}`]: standardInfo };
    mocks.launchSandbox = vi
      .fn()
      .mockRejectedValue(
        new Error(
          "Git clone failed: fatal: could not read Username for 'https://github.com': terminal prompts disabled",
        ),
      );

    renderLanding(`?agent=${AGENT_ID}`);
    await waitFor(() => expect(screen.getByTestId('launch-cloud')).toBeTruthy());
    fireEvent.click(screen.getByTestId('launch-cloud'));

    await waitFor(() =>
      expect(screen.getByTestId('launch-failed').textContent).toContain("Couldn't clone that repository"),
    );
    expect(screen.getByTestId('launch-failed').textContent).not.toContain('terminal prompts');
  });

  it('a sandbox that never came up is started again on retry, not replaced', async () => {
    mocks.launchInfo = { [`agent/${AGENT_ID}`]: standardInfo };
    mocks.launchSandbox = vi
      .fn()
      .mockRejectedValueOnce(new Error('FlowPad did not come up in the sandbox'))
      .mockResolvedValue({ id: NODE_ID });

    renderLanding(`?agent=${AGENT_ID}`);
    await waitFor(() => expect(screen.getByTestId('launch-cloud')).toBeTruthy());
    fireEvent.click(screen.getByTestId('launch-cloud'));
    await waitFor(() => expect(screen.getByTestId('launch-failed').textContent).toContain('did not come up'));
    expect(screen.queryByTestId('launch-open-sandbox')).toBeNull();
    fireEvent.click(screen.getByTestId('launch-cloud-retry'));

    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    expect(mocks.createSandbox).toHaveBeenCalledTimes(1);
    expect(mocks.launchSandbox).toHaveBeenCalledTimes(2);
    expect(mocks.provisionProject).not.toHaveBeenCalled();
  });

  it.each([
    ['the browser handed the link off', true],
    ['nothing reacted yet', false],
  ])('desktop: waits for FlowPad and never calls it a failure — %s', async (_label, handedOff) => {
    mocks.launchInfo = { [`agent/${AGENT_ID}`]: standardInfo };
    mocks.openInFlowpad = vi.fn().mockResolvedValue(handedOff);

    renderLanding(`?agent=${AGENT_ID}`);
    await waitFor(() => expect(screen.getByTestId('launch-desktop')).toBeTruthy());
    fireEvent.click(screen.getByTestId('launch-desktop'));

    await waitFor(() =>
      expect(screen.getByTestId('launch-desktop-waiting').textContent).toContain('Waiting for FlowPad'),
    );
    expect(screen.queryByTestId('launch-failed')).toBeNull();
    expect(screen.getByTestId('launch-get-flowpad').getAttribute('href')).toBe('https://flowpad.ai/');
    // Still a choice: the link can be fired again, and the cloud is one click away.
    fireEvent.click(screen.getByTestId('launch-desktop-again'));
    await waitFor(() => expect(mocks.openInFlowpad).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('launch-cloud').disabled).toBe(false);
  });

  it('a link whose project was never published says so instead of offering dead buttons', async () => {
    mocks.launchInfo = { [`agent/${AGENT_ID}`]: { ...standardInfo, project_id: null, origin: null } };

    renderLanding(`?agent=${AGENT_ID}`);

    await waitFor(() => expect(screen.getByTestId('launch-unpublished').textContent).toContain("isn't published yet"));
    expect(screen.queryByTestId('launch-choice')).toBeNull();
  });

  it('a controller says what is missing under its picker', async () => {
    mocks.launchInfo = { [`agent/${AGENT_ID}`]: controllerInfo };

    renderLanding(`?agent=${AGENT_ID}`);

    await waitFor(() =>
      expect(screen.getByTestId('launch-hint').textContent).toContain('You have no projects here yet'),
    );
    fireEvent.change(screen.getByTestId('launch-target-repo'), { target: { value: 'not a repo' } });
    expect(screen.getByTestId('launch-hint').textContent).toBe("That isn't a repository URL.");
    fireEvent.change(screen.getByTestId('launch-target-repo'), { target: { value: REPO } });
    expect(screen.queryByTestId('launch-hint')).toBeNull();
    expect(screen.getByTestId('launch-desktop').disabled).toBe(false);
  });

  it('a controller with projects to pick from asks for one', async () => {
    mocks.launchInfo = { [`agent/${AGENT_ID}`]: controllerInfo };
    mocks.projects = [spora];

    renderLanding(`?agent=${AGENT_ID}`);

    await waitFor(() => expect(screen.getByTestId('launch-hint').textContent).toContain('Pick the project'));
  });

  describe('GA4 funnel', () => {
    const funnel = () =>
      window.dataLayer.filter((p) => String(p.event).startsWith('launch_')).map((p) => [p.event, p.workflow_stage]);

    beforeEach(() => {
      window.dataLayer = [];
    });

    it('cloud: landing → setup → entered, and the redirect is not an abandon', async () => {
      mocks.launchInfo = { [`agent/${AGENT_ID}`]: standardInfo };

      renderLanding(`?agent=${AGENT_ID}`);
      await waitFor(() => expect(screen.getByTestId('launch-cloud')).toBeTruthy());
      fireEvent.click(screen.getByTestId('launch-cloud'));
      await waitFor(() => expect(assign).toHaveBeenCalled());
      window.dispatchEvent(new Event('pagehide'));

      expect(funnel()).toEqual([
        ['launch_view', 'landing'],
        ['launch_setup_start', 'setup'],
        ['launch_setup_complete', 'setup_complete'],
        ['launch_enter_machine', 'entered'],
      ]);
      expect(window.dataLayer[0]).toMatchObject({ agent_id: AGENT_ID, signed_in: 'true', flow: 'launch' });
    });

    it('signed out: the sign-in click is reported, and leaving then is an abandon at sign-in', () => {
      mocks.currentUser = null;
      vi.spyOn(console, 'log').mockImplementation(() => {});

      renderLanding(`?agent=${AGENT_ID}`);
      fireEvent.click(screen.getByTestId('launch-sign-in'));
      window.dispatchEvent(new Event('pagehide'));

      expect(funnel()).toEqual([
        ['launch_view', 'landing'],
        ['launch_sign_in_start', 'sign_in'],
        ['launch_abandon', 'sign_in'],
      ]);
    });
  });

  it.each([
    ['refused (403)', { response: { status: 403 } }],
    ['not found (404)', { response: { status: 404 } }],
  ])('says why it cannot launch when the hub %s, and which account asked', async (_label, failure) => {
    mocks.launchInfo = { [`agent/${AGENT_ID}`]: Object.assign(new Error('nope'), failure) };

    renderLanding(`?agent=${AGENT_ID}`);

    await waitFor(() =>
      expect(screen.getByTestId('launch-agent-error').textContent).toContain(
        "doesn't exist, or you don't have access to it",
      ),
    );
    expect(screen.getByTestId('launch-account').textContent).toContain('me@acme.test');
    expect(screen.queryByTestId('launch-choice')).toBeNull();
  });

  it('an expired session goes back to the sign-in card, and signing in asks the hub again', async () => {
    mocks.launchInfo = { [`agent/${AGENT_ID}`]: Object.assign(new Error('nope'), { response: { status: 401 } }) };

    renderLanding(`?agent=${AGENT_ID}`);

    await waitFor(() =>
      expect(screen.getByTestId('launch-sign-in-title').textContent).toContain('session has expired'),
    );
    expect(screen.queryByTestId('launch-signed-in')).toBeNull();
    mocks.launchInfo = { [`agent/${AGENT_ID}`]: standardInfo };
    fireEvent.click(screen.getByTestId('launch-sign-in'));

    await waitFor(() => expect(screen.getByTestId('launch-choice')).toBeTruthy());
  });

  it('a read that failed can be tried again', async () => {
    mocks.launchInfo = {
      [`agent/${AGENT_ID}`]: Object.assign(new Error('Network Error'), { response: { status: 500 } }),
    };

    renderLanding(`?agent=${AGENT_ID}`);

    await waitFor(() =>
      expect(screen.getByTestId('launch-agent-error').textContent).toContain("Couldn't load what this link points at"),
    );
    mocks.launchInfo = { [`agent/${AGENT_ID}`]: standardInfo };
    fireEvent.click(screen.getByTestId('launch-reload'));

    await waitFor(() => expect(screen.getByTestId('launch-choice')).toBeTruthy());
  });

  it('a hub that answers with nothing is said, never a blank card', async () => {
    renderLanding(`?agent=${AGENT_ID}`);

    await waitFor(() =>
      expect(screen.getByTestId('launch-agent-error').textContent).toBe('This link has nothing to launch.'),
    );
  });

  it('wears the runtime band of the machine serving the page', () => {
    renderLanding(`?agent=${AGENT_ID}`);

    expect(screen.getByTestId('runtime-strip').getAttribute('data-runtime')).toBeTruthy();
  });

  it('shows it is still loading, and offers nothing yet', () => {
    renderLanding(`?agent=${AGENT_ID}`);

    expect(screen.getByTestId('launch-agent-loading')).toBeTruthy();
    expect(screen.queryByTestId('launch-choice')).toBeNull();
  });

  it('refuses a malformed agent id without asking the hub', () => {
    renderLanding('?agent=not-an-id');

    expect(screen.getByTestId('launch-invalid-link').textContent).toContain("doesn't point at an agent");
    expect(hubReads()).toHaveLength(0);
    expect(mocks.anonGet).not.toHaveBeenCalled();
  });
});
