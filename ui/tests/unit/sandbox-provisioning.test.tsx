/**
 * Setting a sandbox up = composing computeNodeTools, one command per step.
 *
 * The hub owns the commands; this hook decides the ORDER and what the tab
 * finally opens. Two things it must get right, and got wrong before:
 *
 *  - the project the hub just created has to be the one the tab lands in.
 *    Its id came back from the box and was thrown away unless a content-install
 *    spec happened to be present, so "Open from git" dropped you on the
 *    sandbox's front door with the project merely somewhere in the list.
 *  - a name clash has to be caught BEFORE a repo is transferred.
 *
 * `opsCall` is the seam: every command is `ops/<name>` on the node, so
 * capturing `dataManager.callAction` captures the whole conversation with the
 * hub in order.
 */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  calls: [] as Array<{ action: string; op?: string; body?: Record<string, unknown> }>,
  /** command name (or action, for non-ops calls) → what the hub answers. */
  responses: new Map<string, () => Promise<unknown>>(),
  openedUrl: null as string | null,
}));

vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  class FakeActionInfo {
    subpath: string[] = [];
    bodyParameters: Record<string, unknown> | undefined;
    queryParameters: Record<string, unknown> | undefined;
    constructor(
      public action: string,
      public type?: string,
      public id?: string,
      public method?: string,
    ) {}
  }
  return {
    ...actual,
    ActionInfo: FakeActionInfo,
    dataContext: { workspaceTypeId: null },
    dataManager: {
      save: vi.fn(() => Promise.resolve(undefined)),
      callAction: vi.fn((info: FakeActionInfo) => {
        const op = info.subpath?.[0];
        h.calls.push({ action: info.action, op, body: info.bodyParameters });
        const answer = h.responses.get(op ?? info.action);
        return answer ? answer() : Promise.resolve({ status: 'ok' });
      }),
    },
  };
});

vi.mock('@sdk/react/hooks', () => ({
  useAuth: () => ({ user: { id: 'u1' } }),
  useEntitiesQuery: () => ({ data: [], isLoading: false, refetch: vi.fn(() => Promise.resolve(undefined)) }),
}));

vi.mock('@src/notifications', () => ({ notify: { warning: vi.fn(), error: vi.fn() } }));

import { useDesktops } from '@src/hooks/use-desktops';

const ORIGIN = { provider: 'github', owner: 'langware-labs', name: 'flowpad-hub', branch: 'main', rel_path: '.' };
const PROJECT_ID = 'a4acdbfb-3ad0-45ac-a8d1-812485a376ce';

function ops(): string[] {
  return h.calls.filter((c) => c.action === 'ops').map((c) => c.op!);
}

function bodyOf(op: string): Record<string, unknown> | undefined {
  return h.calls.find((c) => c.op === op)?.body;
}

/** Queue what the hub answers, per command. */
function answers(map: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(map)) h.responses.set(key, () => Promise.resolve(value));
}

function fails(op: string, message: string): void {
  h.responses.set(op, () => Promise.reject(new Error(message)));
}

beforeEach(() => {
  h.calls.length = 0;
  h.responses.clear();
  h.openedUrl = null;
  answers({
    'get-host': { url: 'https://box.e2b.dev/?next=/', port: 9007 },
    setup: 'provider-1',
    'workspace-ready': { healthy: true, logged_in: true, login_detail: 'someone' },
    'validate-project-name': { available: true, suggested: 'flowpad-hub' },
    'clone-project': { project: { id: PROJECT_ID }, path: '/root/workspace/flowpad-hub', manifest: [] },
  });
  vi.stubGlobal('open', () => ({
    document: { write: vi.fn(), close: vi.fn(), getElementById: () => null },
    // The hook assigns `tab.location.href`; record it as "what the user ends up
    // looking at", which is the assertion every landing test makes.
    location: {
      set href(value: string) {
        h.openedUrl = value;
      },
    },
    close: vi.fn(),
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function launchWithGit(overrides: Record<string, unknown> = {}) {
  const { result } = renderHook(() => useDesktops());
  await act(async () => {
    await result.current.launch({
      name: 'flowpad-hub',
      sandboxProject: { name: 'flowpad-hub', gitOrigin: ORIGIN as never, ...overrides },
    });
  });
  return result;
}

/** A sandbox project with no repository behind it — nothing to clone. */
async function launchWithoutRepo(overrides: Record<string, unknown> = {}) {
  const { result } = renderHook(() => useDesktops());
  await act(async () => {
    await result.current.launch({
      name: 'scratch',
      sandboxProject: { name: 'scratch', ...overrides },
    });
  });
  return result;
}

function rows(result: { current: { steps: { id: string }[] } }): string[] {
  return result.current.steps.map((s) => s.id);
}

describe('sandbox provisioning composes computeNodeTools', () => {
  it('runs the commands in order: validate before clone, default before open', async () => {
    await launchWithGit();

    expect(ops()).toEqual([
      'setup',
      'workspace-ready',
      'validate-project-name',
      'clone-project',
      'index-project',
      'set-default-project',
    ]);
  });

  it('lands the tab INSIDE the project it just created', async () => {
    await launchWithGit();

    // The whole point: not the box's front door.
    expect(h.openedUrl).toContain(PROJECT_ID);
  });

  it('adopts one project id across hub and box, and names it as the default', async () => {
    await launchWithGit({ projectId: PROJECT_ID });

    expect(bodyOf('clone-project')?.project_id).toBe(PROJECT_ID);
    expect(bodyOf('set-default-project')?.project_id).toBe(PROJECT_ID);
  });

  it('indexes the path the box reported, not a guess at where it landed', async () => {
    await launchWithGit();

    expect(bodyOf('index-project')?.path).toBe('/root/workspace/flowpad-hub');
  });

  it('stops on a name clash before any repo is transferred', async () => {
    answers({ 'validate-project-name': { available: false, suggested: 'flowpad-hub-2' } });

    const result = await launchWithGit();

    expect(ops()).not.toContain('clone-project');
    const validate = result.current.steps.find((s) => s.id === 'validate');
    expect(validate?.status).toBe('error');
    expect(validate?.detail).toContain('flowpad-hub-2');
  });

  it('keeps the steps that succeeded when a later one fails', async () => {
    fails('index-project', 'indexer is busy');

    const result = await launchWithGit();

    const byId = Object.fromEntries(result.current.steps.map((s) => [s.id, s]));
    expect(byId.clone.status).toBe('success');
    expect(byId.index.status).toBe('error');
    expect(byId.index.detail).toContain('indexer is busy');
    // A failed step must not be reported as a finished launch.
    expect(h.openedUrl).toBeNull();
  });

  it('clones and attaches what the repo declares, without being told', async () => {
    answers({
      'clone-project': {
        project: { id: PROJECT_ID },
        path: '/root/workspace/flowpad-hub',
        manifest: [{ url: 'https://github.com/acme/acme-support', branch: 'main', scope: 'shared' }],
      },
    });

    await launchWithGit();

    // Two clones: the engagement, then the declared help desk.
    const clones = h.calls.filter((c) => c.op === 'clone-project');
    expect(clones).toHaveLength(2);
    expect((clones[1].body?.git_origin as { name?: string })?.name).toBe('acme-support');
    expect(bodyOf('attach-context-project')).toMatchObject({
      project_id: PROJECT_ID,
      scope: 'shared',
    });
  });

  it('leaves a declarative install to reconcile instead of attaching twice', async () => {
    answers({
      'clone-project': {
        project: { id: PROJECT_ID },
        path: '/root/workspace/flowpad-hub',
        manifest: [{ url: 'https://github.com/acme/acme-support', branch: 'main', scope: 'shared' }],
      },
      'reconcile-manifest': { target_project_id: PROJECT_ID, auto_launch_journey_id: null },
    });

    await launchWithGit({ install: { kind: 'journey', id: 'onboarding' } });

    expect(ops()).toContain('reconcile-manifest');
    expect(ops()).not.toContain('attach-context-project');
    expect(h.calls.filter((c) => c.op === 'clone-project')).toHaveLength(1);
  });

  it('mounts a repo-less project instead of cloning it', async () => {
    answers({
      'init-empty-project': { project: { id: PROJECT_ID }, path: '/root/workspace/scratch' },
    });

    const result = await launchWithoutRepo();

    expect(ops()).toEqual(['setup', 'workspace-ready', 'init-empty-project', 'index-project', 'set-default-project']);
    expect(ops()).not.toContain('clone-project');
    expect(ops()).not.toContain('validate-project-name');
    // Still the project the tab opens on, and still indexed by path.
    expect(bodyOf('set-default-project')?.project_id).toBe(PROJECT_ID);
    expect(bodyOf('index-project')?.path).toBe('/root/workspace/scratch');
    expect(h.openedUrl).toContain(PROJECT_ID);
    expect(rows(result)).toEqual(['launch', 'health', 'init', 'index', 'default', 'open']);
  });

  it('shows the rows the launch will actually run, not a fixed list', async () => {
    const result = await launchWithGit();

    // A git-backed project can declare context projects only the clone reveals,
    // so its `context` row is planned even when none turn up.
    expect(rows(result)).toEqual([
      'launch',
      'health',
      'validate',
      'clone',
      'index',
      'context',
      'default',
      'open',
    ]);
  });

  it('plans a context row for a repo-less project only when assets were asked for', async () => {
    answers({
      'init-empty-project': { project: { id: PROJECT_ID }, path: '/root/workspace/scratch' },
    });

    const result = await launchWithoutRepo({
      contextProjects: [{ gitOrigin: ORIGIN, name: 'acme-support', scope: 'shared' }],
    });

    expect(rows(result)).toContain('context');
    expect(bodyOf('attach-context-project')).toMatchObject({ project_id: PROJECT_ID, scope: 'shared' });
  });

  it('skips every git command when launching a bare desktop', async () => {
    const { result } = renderHook(() => useDesktops());
    await act(async () => {
      await result.current.launch({ name: 'Desktop 2' });
    });

    expect(ops()).toEqual(['setup', 'workspace-ready']);
    expect(h.openedUrl).toBe('https://box.e2b.dev/?next=/');
    expect(result.current.steps.map((s) => s.id)).toEqual(['launch', 'health', 'open']);
  });
});
