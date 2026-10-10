/**
 * `runLaunch` — the SETUP stage both launch legs land on (`action=launch`).
 *
 * What it must hold: the controller and the target are each ensured HERE (and only through
 * `launchEnsure` — nothing attaches one to the other); only a controller is set up, and only
 * when it is not ready; the face is the link's agent, else the controller's home page, else the
 * target's — and it opens IN the target.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  calls: [] as string[],
  readiness: { ready: true } as { ready: boolean } | null,
  homes: {} as Record<string, { asset: string | null; type: string | null }>,
  faces: [] as Array<{ face: unknown; projectId: string }>,
}));

vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const Project = actual.Project as { new (data: Record<string, unknown>): unknown };
  return {
    ...actual,
    Project: Object.assign(Project, {
      launchEnsure: (id: string) => {
        mocks.calls.push(`ensure:${id}`);
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

const { runLaunch } = await import('@src/pages/entry/launch-runner');

// Real v4 ids: a Project validates its id.
const Q = '11111111-2222-4333-8444-555555555555';
const SPORA = '22222222-3333-4444-8555-666666666666';
const A1 = '33333333-4444-4555-8666-777777777777';

beforeEach(() => {
  mocks.calls = [];
  mocks.readiness = { ready: true };
  mocks.homes = {};
  mocks.faces = [];
});

describe('runLaunch', () => {
  it('ensures both projects, sets up the controller, and opens the face IN the target', async () => {
    const steps: string[] = [];
    mocks.homes = { [Q]: { asset: 'agent-q', type: 'agent' } };

    await runLaunch({ target: { projectId: SPORA }, controllerId: Q }, {
      computeNodeId: null,
      onStep: (s) => steps.push(s),
    });

    expect(steps).toEqual(['controller', 'target', 'setup', 'session']);
    expect(mocks.calls).toEqual([`ensure:${Q}`, `ensure:${SPORA}`, `readiness:${Q}`, `select:${SPORA}`]);
    expect(mocks.faces).toEqual([{ face: { asset: 'agent-q', type: 'agent' }, projectId: SPORA }]);
  });

  it('sets up a controller that is not ready — and never the target', async () => {
    mocks.readiness = { ready: false };

    await runLaunch({ target: { projectId: SPORA }, controllerId: Q }, { computeNodeId: null });

    expect(mocks.calls).toContain(`setup:${Q}`);
    expect(mocks.calls.filter((c) => c.endsWith(`:${SPORA}`))).toEqual([`ensure:${SPORA}`, `select:${SPORA}`]);
  });

  it("the link's agent outranks every home page", async () => {
    mocks.homes = { [Q]: { asset: 'agent-q', type: 'agent' }, [SPORA]: { asset: 'agent-s', type: 'agent' } };

    await runLaunch({ target: { projectId: SPORA }, controllerId: Q, agentId: A1 }, { computeNodeId: null });

    expect(mocks.faces[0].face).toEqual({ asset: `agent-${A1}`, type: 'agent' });
  });

  it("with no controller, the target's own home page is the face and nothing is set up", async () => {
    mocks.homes = { [SPORA]: { asset: 'agent-s', type: 'agent' } };
    const steps: string[] = [];

    await runLaunch({ target: { projectId: SPORA } }, { computeNodeId: null, onStep: (s) => steps.push(s) });

    expect(steps).toEqual(['controller', 'target', 'session']);
    expect(mocks.calls).toEqual([`ensure:${SPORA}`, `select:${SPORA}`]);
    expect(mocks.faces[0].face).toEqual({ asset: 'agent-s', type: 'agent' });
  });

  it('falls back to the project when there is no face to open', async () => {
    const dock = await runLaunch({ target: { projectId: SPORA } }, { computeNodeId: null });

    expect(dock.toUrl()).toContain(SPORA);
  });
});
