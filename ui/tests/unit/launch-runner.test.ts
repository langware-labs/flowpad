/**
 * `runLaunch` — the SETUP stage both launch legs land on (`action=launch`).
 *
 * What it must hold: the controller and the target are each ensured HERE (and only through
 * `launchEnsure` — nothing attaches one to the other); only a controller is set up, and only
 * when it is not ready; the face is the link's agent, else the controller's home page, else the
 * target's — and an agent face STARTS a new session in the target (Home would resume its last
 * chat; a launch was asked to run). A launch that stops says at which step.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const SESSION = vi.hoisted(() => '66666666-7777-4888-8999-aaaaaaaaaaaa');

const mocks = vi.hoisted(() => ({
  calls: [] as string[],
  readiness: { ready: true } as { ready: boolean } | null,
  homes: {} as Record<string, { asset: string | null; type: string | null }>,
  /** Non-agent faces routed to the home-page dock. */
  faces: [] as Array<{ face: unknown; projectId: string }>,
  /** Sessions started: `[agent id, project id]`. */
  started: [] as Array<[string, string | null]>,
  /** The project id `launchEnsure` refuses. */
  failEnsure: null as string | null,
  failStart: null as Error | null,
  noAgent: false,
}));

vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const Project = actual.Project as { new (data: Record<string, unknown>): unknown };
  const Agent = actual.Agent as { new (data: Record<string, unknown>): unknown };
  return {
    ...actual,
    Agent: Object.assign(Agent, {
      getById: (id: string) => Promise.resolve(mocks.noAgent ? null : new Agent({ id, name: 'q' })),
    }),
    Project: Object.assign(Project, {
      launchEnsure: (id: string) => {
        mocks.calls.push(`ensure:${id}`);
        if (mocks.failEnsure === id) return Promise.reject(new Error('not available'));
        return Promise.resolve(new Project({ id, name: id }));
      },
      setupRequirements: (id: string) => {
        mocks.calls.push(`readiness:${id}`);
        return Promise.resolve(mocks.readiness);
      },
      startSetup: (id: string) => {
        mocks.calls.push(`setup:${id}`);
        return Promise.resolve('run-1');
      },
      openHomePage: (id: string) => Promise.resolve(mocks.homes[id] ?? { asset: null, type: null }),
    }),
  };
});

vi.mock('@src/components/agents/use-agent-launcher', () => ({
  startAgentSession: (agent: { id: string }, projectId: string | null) => {
    if (mocks.failStart) return Promise.reject(mocks.failStart);
    mocks.started.push([agent.id, projectId]);
    return Promise.resolve(SESSION);
  },
}));

vi.mock('@src/components/project-selector/use-ensure-project', () => ({
  canonicalPath: (p: string) => p,
  selectProjectContext: (p: { id: string }) => {
    mocks.calls.push(`select:${p.id}`);
    return Promise.resolve();
  },
}));

vi.mock('@src/project-home-page/project-home-page-redirect', () => ({
  homePageDock: (face: unknown, projectId: string) => {
    mocks.faces.push({ face, projectId });
    return Promise.resolve(null);
  },
}));

const { LaunchFailure, runLaunch } = await import('@src/pages/entry/launch-runner');

// Real v4 ids: a Project validates its id.
const Q = '11111111-2222-4333-8444-555555555555';
const SPORA = '22222222-3333-4444-8555-666666666666';
const A1 = '33333333-4444-4555-8666-777777777777';
const QA = '44444444-5555-4666-8777-888888888888';
const SA = '55555555-6666-4777-8888-999999999999';

beforeEach(() => {
  mocks.calls = [];
  mocks.readiness = { ready: true };
  mocks.homes = {};
  mocks.faces = [];
  mocks.started = [];
  mocks.failEnsure = null;
  mocks.failStart = null;
  mocks.noAgent = false;
});

describe('runLaunch', () => {
  it('ensures both projects, sets up the controller, and starts its agent IN the target', async () => {
    const steps: string[] = [];
    mocks.homes = { [Q]: { asset: `agent-${QA}`, type: 'agent' } };

    const dock = await runLaunch(
      { target: { projectId: SPORA }, controllerId: Q },
      {
        computeNodeId: null,
        onStep: (s) => steps.push(s),
      },
    );

    expect(steps).toEqual(['controller', 'target', 'setup', 'session']);
    expect(mocks.calls).toEqual([`ensure:${Q}`, `ensure:${SPORA}`, `readiness:${Q}`, `select:${SPORA}`]);
    // A NEW session of the controller's agent, acting in the target — and that is where it lands.
    expect(mocks.started).toEqual([[QA, SPORA]]);
    expect(dock.toUrl()).toContain(SESSION);
    expect(mocks.faces).toEqual([]);
  });

  it('hands a controller that is not ready to the caller to set up — and never the target', async () => {
    mocks.readiness = { ready: false };
    const needsSetup: string[] = [];

    await runLaunch(
      { target: { projectId: SPORA }, controllerId: Q },
      {
        computeNodeId: null,
        onNeedsSetup: (p) => needsSetup.push(p.id),
      },
    );

    expect(needsSetup).toEqual([Q]);
    expect(mocks.calls.filter((c) => c.endsWith(`:${SPORA}`))).toEqual([`ensure:${SPORA}`, `select:${SPORA}`]);
  });

  it.each([
    ['controller', Q],
    ['target', SPORA],
  ])('a project that cannot be fetched fails as its own step: %s', async (step, failing) => {
    mocks.failEnsure = failing;

    const failure = await runLaunch({ target: { projectId: SPORA }, controllerId: Q }, { computeNodeId: null }).catch(
      (e: unknown) => e,
    );

    expect(failure).toBeInstanceOf(LaunchFailure);
    expect((failure as InstanceType<typeof LaunchFailure>).step).toBe(step);
    expect((failure as Error).message).toBe('not available');
    expect(mocks.started).toEqual([]);
  });

  it('a session that cannot start fails at the session step with its own reason', async () => {
    mocks.homes = { [SPORA]: { asset: `agent-${SA}`, type: 'agent' } };
    mocks.failStart = new Error('claude has no usable LLM source');

    const failure = await runLaunch({ target: { projectId: SPORA } }, { computeNodeId: null }).catch((e: unknown) => e);

    expect((failure as InstanceType<typeof LaunchFailure>).step).toBe('session');
    expect((failure as InstanceType<typeof LaunchFailure>).cause).toBe(mocks.failStart);
  });

  it('an agent the project does not hold is said, not swapped for the bare project', async () => {
    mocks.homes = { [SPORA]: { asset: `agent-${SA}`, type: 'agent' } };
    mocks.noAgent = true;

    const failure = await runLaunch({ target: { projectId: SPORA } }, { computeNodeId: null }).catch((e: unknown) => e);

    expect((failure as InstanceType<typeof LaunchFailure>).step).toBe('session');
    expect((failure as Error).message).toContain("isn't in the project's files");
  });

  it("the link's agent outranks every home page", async () => {
    mocks.homes = { [Q]: { asset: `agent-${QA}`, type: 'agent' }, [SPORA]: { asset: `agent-${SA}`, type: 'agent' } };

    await runLaunch({ target: { projectId: SPORA }, controllerId: Q, agentId: A1 }, { computeNodeId: null });

    expect(mocks.started).toEqual([[A1, SPORA]]);
  });

  it("with no controller, the target's own home-page agent is started and nothing is set up", async () => {
    mocks.homes = { [SPORA]: { asset: `agent-${SA}`, type: 'agent' } };
    const steps: string[] = [];

    await runLaunch({ target: { projectId: SPORA } }, { computeNodeId: null, onStep: (s) => steps.push(s) });

    expect(steps).toEqual(['target', 'session']);
    expect(mocks.calls).toEqual([`ensure:${SPORA}`, `select:${SPORA}`]);
    expect(mocks.started).toEqual([[SA, SPORA]]);
  });

  it('a home page that is not an agent opens the way Home opens it', async () => {
    mocks.homes = { [SPORA]: { asset: 'micro_app-x', type: 'micro_app' } };

    await runLaunch({ target: { projectId: SPORA } }, { computeNodeId: null });

    expect(mocks.started).toEqual([]);
    expect(mocks.faces).toEqual([{ face: { asset: 'micro_app-x', type: 'micro_app' }, projectId: SPORA }]);
  });

  it('falls back to the project when there is no face to open', async () => {
    const dock = await runLaunch({ target: { projectId: SPORA } }, { computeNodeId: null });

    expect(dock.toUrl()).toContain(SPORA);
  });
});
