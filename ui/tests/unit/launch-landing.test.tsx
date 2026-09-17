/**
 * `/launch` — the two things a link can name, and the one link it may not be.
 *
 * `?repo=` is the pre-existing "try this repo" flow and must not move. `?agent=` is its own page:
 * sign in, then straight into a sandbox running the agent's repository, and a redirect to the
 * machine once it is up. Every agent case is really about when that launch may start: never while
 * signed out, never before the agent's repository is known, and exactly once.
 *
 * Signed out, the page only makes a QUIET anonymous read (`apiClient.get`, its 401 never
 * surfaced): a public agent answers it and is named on the sign-in card; a private one is
 * refused, which is expected and never shown. Signed in, `useEntity` is the seam for the hub
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
  /** What `useAuth().currentUser` reports: truthy = signed in. */
  currentUser: null as unknown,
  /** What the hub read answers with, when the page is allowed to make it. */
  entity: {} as Record<string, unknown>,
  entityCalls: [] as EntityCall[],
}));

vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    cloudManager: { ...(actual.cloudManager as object), login: (opts: unknown) => mocks.login(opts) },
  };
});

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
      steps: mocks.steps,
      launchUrl: null,
    }),
  };
});

const { Agent, gitOriginFromUrl } = await import('@sdk');
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

/** What gets cloned for `publishedOrigin`: the repo root at the published branch. */
const launchedOrigin = {
  kind: 'git',
  provider: 'github',
  owner: 'acme',
  name: 'agents',
  branch: 'flow-cloud',
  head_commit: null,
  rel_path: '.',
};

const agentRow = (over: Record<string, unknown> = {}) => ({
  id: AGENT_ID,
  name: 'q',
  title: 'Q the helper',
  git_origin: publishedOrigin,
  ...over,
});

const publishedAgent = (over: Record<string, unknown> = {}) => new Agent(agentRow(over));

/** How the hub refuses an anonymous read of a private agent. */
const privateRefusal = () => Object.assign(new Error('Request failed with status code 401'), { response: { status: 401 } });

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
  mocks.currentUser = { id: 'user-1' };
  mocks.entity = answered({});
  mocks.entityCalls = [];
  vi.spyOn(apiClient, 'get').mockImplementation((...args: unknown[]) => mocks.anonGet(...args));
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
    sessionStorage.setItem(INTENT_KEY, JSON.stringify({ repo: 'https://github.com/acme/other', branch: '', agent: '' }));

    renderLanding(`?repo=${REPO}`);
    await settle();

    expect(mocks.launch).not.toHaveBeenCalled();
  });
});

describe('/launch with both repo and agent', () => {
  it('refuses the link: nothing is read, nothing can be approved', () => {
    renderLanding(`?repo=${REPO}&agent=${AGENT_ID}`);

    expect(screen.getByTestId('launch-invalid-link').textContent).toContain('both a repository and an agent');
    expect(screen.queryByTestId('launch-approve')).toBeNull();
    expect(screen.queryByTestId('launch-repo')).toBeNull();
    expect(hubReads()).toHaveLength(0);
    expect(mocks.launch).not.toHaveBeenCalled();
  });
});

describe('/launch?agent=', () => {
  const originalLocation = window.location;
  let assign: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // jsdom's real `location.assign` is unimplemented and logs a "not implemented"
    // error instead of navigating — the same swap `open-sandbox-landing` makes.
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

  it('signed out, private agent: generic sign-in line, the refusal is only logged', async () => {
    mocks.currentUser = null;
    mocks.entity = answered({ data: publishedAgent() });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    renderLanding(`?agent=${AGENT_ID}`);

    expect(screen.getByTestId('launch-sign-in-title').textContent).toBe(
      'Please sign in to flowpad to continue with the agent creation process.',
    );
    expect(screen.queryByTestId('launch-signed-in')).toBeNull();
    // The signed-in read is never made while signed out — only the quiet one.
    expect(hubReads()).toHaveLength(0);
    await waitFor(() =>
      expect(mocks.anonGet).toHaveBeenCalledWith(`/api/v1/graph/agent/${AGENT_ID}`),
    );
    await waitFor(() => expect(log).toHaveBeenCalled());
    // An expected refusal is not the user's business.
    expect(screen.queryByTestId('launch-agent-error')).toBeNull();
    expect(screen.queryByTestId('launch-setting-up')).toBeNull();
    expect(screen.getByTestId('launch-sign-in-title').textContent).toContain('agent creation process');

    fireEvent.click(screen.getByTestId('launch-sign-in'));
    expect(mocks.login).toHaveBeenCalledWith({ refresh: 'session' });
    await settle();
    expect(mocks.createSandbox).not.toHaveBeenCalled();
  });

  it('signed out in the app but known to the hub (403): says the agent cannot be launched', async () => {
    mocks.currentUser = null;
    // `target_not_found` is only ever the answer to a caller the hub has identified.
    mocks.anonGet = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('Request failed with status code 403'), { response: { status: 403 } }));

    renderLanding(`?agent=${AGENT_ID}`);

    await waitFor(() =>
      expect(screen.getByTestId('launch-agent-error').textContent).toBe(
        "Can't launch this agent: it doesn't exist, or you don't have access to it.",
      ),
    );
    expect(screen.queryByTestId('launch-setting-up')).toBeNull();
    await settle();
    expect(mocks.createSandbox).not.toHaveBeenCalled();
  });

  it('signed out, public agent: names it on the sign-in card and starts nothing', async () => {
    mocks.currentUser = null;
    mocks.anonGet = vi.fn().mockResolvedValue(agentRow());

    renderLanding(`?agent=${AGENT_ID}`);

    await waitFor(() =>
      expect(screen.getByTestId('launch-sign-in-title').textContent).toBe(
        'Please sign in to start the agent Q the helper…',
      ),
    );
    expect(screen.getByTestId('launch-sign-in')).toBeTruthy();
    expect(screen.queryByTestId('launch-setting-up')).toBeNull();
    expect(screen.queryByTestId('launch-agent-no-repo')).toBeNull();
    await settle();
    expect(mocks.createSandbox).not.toHaveBeenCalled();
  });

  it('signed in: sets the agent up with no click, then opens the machine in this tab', async () => {
    mocks.entity = answered({ data: publishedAgent() });

    renderLanding(`?agent=${AGENT_ID}`);

    expect(hubReads().some((c) => c.typeId?.type === 'agent' && c.typeId?.id === AGENT_ID)).toBe(true);
    expect(screen.getByTestId('launch-signed-in').textContent).toContain('Signed in');
    expect(screen.queryByTestId('launch-sign-in')).toBeNull();
    expect(screen.getByTestId('launch-setting-up').textContent).toContain(
      'Setting up your Q the helper on a new sandbox',
    );

    const sandboxProject = { gitOrigin: launchedOrigin, name: 'agents' };
    await waitFor(() => expect(assign).toHaveBeenCalledWith(workspaceServiceUrl(NODE_ID)));
    expect(mocks.createSandbox).toHaveBeenCalledWith({ name: 'agents', sandboxProject });
    expect(mocks.launchSandbox).toHaveBeenCalledWith({ id: NODE_ID }, { sandboxProject });
    // Never the new-tab launch: that ends in `window.open`, which is not where this page goes.
    expect(mocks.launch).not.toHaveBeenCalled();
    // Signed in, the quiet anonymous read is never made.
    expect(mocks.anonGet).not.toHaveBeenCalled();
  });

  it('shows setup progress as the share of finished steps, not a spinner', () => {
    mocks.entity = answered({ data: publishedAgent() });
    // Never settles, so the page stays on the setup view with these rows.
    mocks.createSandbox = vi.fn(() => new Promise(() => {}));
    mocks.steps = [
      { id: 'launch', label: 'Create', status: 'success' },
      { id: 'health', label: 'Start', status: 'success' },
      { id: 'clone', label: 'Clone', status: 'loading' },
      { id: 'open', label: 'Open', status: 'idle' },
    ];

    renderLanding(`?agent=${AGENT_ID}`);

    // A row still loading counts for nothing: 2 of 4 finished.
    expect(screen.getByTestId('launch-percent').textContent).toBe('50%');
    expect(screen.getByTestId('launch-progress')).toBeTruthy();
  });

  it('starts at 0% before any setup row exists', () => {
    mocks.entity = answered({ data: publishedAgent() });
    mocks.createSandbox = vi.fn(() => new Promise(() => {}));

    renderLanding(`?agent=${AGENT_ID}`);

    expect(screen.getByTestId('launch-percent').textContent).toBe('0%');
  });

  it('launches exactly once, however often the page re-renders', async () => {
    mocks.entity = answered({ data: publishedAgent() });

    const { rerender } = renderLanding(`?agent=${AGENT_ID}`);
    rerender(
      <MemoryRouter initialEntries={[`/launch?agent=${AGENT_ID}`]}>
        <Routes>
          <Route path="launch" element={<LaunchLanding />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    expect(mocks.createSandbox).toHaveBeenCalledTimes(1);
  });

  it('honours ?name= for the project an agent link creates', async () => {
    mocks.entity = answered({ data: publishedAgent() });

    renderLanding(`?agent=${AGENT_ID}&name=Support%20desk`);

    await waitFor(() => expect(mocks.createSandbox).toHaveBeenCalled());
    expect(mocks.createSandbox.mock.calls[0][0].name).toBe('Support desk');
  });

  it('shows why the setup failed, and does not redirect', async () => {
    mocks.entity = answered({ data: publishedAgent() });
    mocks.launchSandbox = vi.fn().mockRejectedValue(new Error('FlowPad did not come up in the sandbox'));

    renderLanding(`?agent=${AGENT_ID}`);

    await waitFor(() =>
      expect(screen.getByTestId('launch-failed').textContent).toContain('FlowPad did not come up in the sandbox'),
    );
    expect(screen.queryByTestId('launch-setting-up')).toBeNull();
    expect(assign).not.toHaveBeenCalled();
  });

  it.each([
    ['refused (403)', answered({ isError: true, error: { response: { status: 403 } } })],
    ['not found', answered({ notFound: true })],
  ])('says the agent is unavailable when the hub %s', async (_label, hubAnswer) => {
    mocks.entity = hubAnswer;

    renderLanding(`?agent=${AGENT_ID}`);

    expect(screen.getByTestId('launch-agent-error').textContent).toContain(
      "doesn't exist, or you don't have access to it",
    );
    expect(screen.queryByTestId('launch-setting-up')).toBeNull();
    await settle();
    expect(mocks.createSandbox).not.toHaveBeenCalled();
  });

  it('asks for a fresh sign-in when the session expired mid-read', () => {
    mocks.entity = answered({ isError: true, error: { response: { status: 401 } } });

    renderLanding(`?agent=${AGENT_ID}`);

    expect(screen.getByTestId('launch-agent-error').textContent).toContain('session has expired');
  });

  it('shows the agent is still loading, and starts nothing yet', async () => {
    mocks.entity = answered({ data: undefined, isLoading: true });

    renderLanding(`?agent=${AGENT_ID}`);

    expect(screen.getByTestId('launch-agent-loading')).toBeTruthy();
    expect(screen.queryByTestId('launch-setting-up')).toBeNull();
    await settle();
    expect(mocks.createSandbox).not.toHaveBeenCalled();
  });

  it('has nothing to launch for an agent never published from git', async () => {
    mocks.entity = answered({ data: publishedAgent({ git_origin: null }) });

    renderLanding(`?agent=${AGENT_ID}`);

    expect(screen.getByTestId('launch-agent-no-repo')).toBeTruthy();
    expect(screen.queryByTestId('launch-setting-up')).toBeNull();
    await settle();
    expect(mocks.createSandbox).not.toHaveBeenCalled();
  });

  it('refuses a malformed agent id without asking the hub', () => {
    renderLanding('?agent=not-an-id');

    expect(screen.getByTestId('launch-invalid-link').textContent).toContain("doesn't point at an agent");
    expect(screen.queryByTestId('launch-approve')).toBeNull();
    expect(hubReads()).toHaveLength(0);
    expect(mocks.anonGet).not.toHaveBeenCalled();
  });
});
