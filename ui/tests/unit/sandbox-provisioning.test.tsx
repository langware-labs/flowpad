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
 * `ComputeNode.ops` is the seam: every command is `ops/<name>` on the node, so
 * capturing that one method captures the whole conversation with the hub, in
 * order. It used to be a private `opsCall` inside this hook; the hook now drives
 * the SDK entity instead, which is the point — one transport, and the same
 * methods any other caller would use. Mocking `@sdk`'s `dataManager` no longer
 * reaches it: the entity imports its own, so the mock would silently capture
 * nothing (it did — this file went to zero recorded calls when the hook moved).
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
    subpath: string[] | string = [];
    bodyParameters: Record<string, unknown> | undefined;
    queryParameters: Record<string, unknown> | undefined;
    constructor(
      public action: string,
      public type?: string,
      public id?: string,
      public method?: string,
    ) {}
    /**
     * The url `openSandbox` navigates to. The real ActionInfo builds this from
     * the configured api base; the fake reproduces only the SHAPE, which is what
     * these tests assert on. `open-sandbox-service-url.test.ts` pins the real
     * builder against the hub's own route contract.
     */
    get fullActionUrl(): string {
      const sub = Array.isArray(this.subpath) ? this.subpath : [this.subpath];
      return ['/api/v1/graph', this.type, this.id, this.action, ...sub].filter(Boolean).join('/');
    }
  }
  return {
    ...actual,
    ActionInfo: FakeActionInfo,
    dataContext: { workspaceTypeId: null, bootstrapInfo: { default_compute_provider: 'gcp_vm' } },
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

import { ComputeNode, dataManager } from '@sdk';
import { useSandboxes } from '@src/hooks/use-sandboxes';

// The one choke point every `ops/<name>` command goes through, so a single spy
// records the conversation in order. `ops` is private to TypeScript only; at
// runtime it is an ordinary prototype method, and it is deliberately the ONLY
// place a client builds an ops url.
vi.spyOn(ComputeNode.prototype as unknown as { ops: unknown } as never, 'ops' as never).mockImplementation((async (
  op: string,
  body?: Record<string, unknown>,
) => {
  h.calls.push({ action: 'ops', op, body });
  const answer = h.responses.get(op);
  return answer ? await answer() : { status: 'ok' };
}) as never);

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
    setup: 'provider-1',
    'workspace-ready': { healthy: true, logged_in: true, login_detail: 'someone' },
    'validate-project-name': { available: true, suggested: 'flowpad-hub' },
    'clone-project': { project: { id: PROJECT_ID }, path: '/root/workspace/flowpad-hub', manifest: [] },
  });
  // The tab is now opened WITH its final url — there is no placeholder document
  // to write and no `location.href` assigned afterwards, so the url to assert on
  // is simply the first argument.
  vi.stubGlobal('open', (url?: string) => {
    h.openedUrl = url ?? null;
    return { close: vi.fn() };
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Launch with a sandbox project of whatever shape the test needs. */
async function launchWith(sandboxProject: Record<string, unknown>) {
  const { result } = renderHook(() => useSandboxes());
  await act(async () => {
    await result.current.launch({ name: String(sandboxProject.name), sandboxProject: sandboxProject as never });
  });
  return result;
}

const launchWithGit = (overrides: Record<string, unknown> = {}) =>
  launchWith({ name: 'flowpad-hub', gitOrigin: ORIGIN, ...overrides });

/** A sandbox project with no repository behind it — nothing to clone. */
const launchWithoutRepo = (overrides: Record<string, unknown> = {}) => launchWith({ name: 'scratch', ...overrides });

function rows(result: { current: { steps: { id: string }[] } }): string[] {
  return result.current.steps.map((s) => s.id);
}

describe('sandbox provisioning composes computeNodeTools', () => {
  it('creates the node on the provider selected by Hub bootstrap', async () => {
    await launchWithoutRepo();

    expect(dataManager.save).toHaveBeenCalledWith(
      expect.anything(),
      [],
      expect.objectContaining({ node_provider: 'gcp_vm' }),
    );
  });

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

  it('opens through open-service, and never resolves a host itself', async () => {
    await launchWithGit();

    // ONE public link, whatever the box was set up with. The hub owns the rest:
    // authorization, resuming a paused machine, waiting for the app to answer,
    // and only then the redirect. A client-resolved host could do none of that.
    expect(h.openedUrl).toContain('/open-service/workspace');
    expect(h.openedUrl).not.toContain('e2b.dev');
    expect(ops()).not.toContain('get-host');
  });

  it('no longer deep-links into the cloned project', async () => {
    // An accepted consequence of collapsing the two open paths into one:
    // open-service takes no landing path, so a box created with a repo opens on
    // its front door rather than inside that project. Asserted rather than left
    // implicit, so re-adding a landing path is a deliberate change to this test.
    await launchWithGit();

    expect(h.openedUrl).not.toContain(PROJECT_ID);
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

    expect(ops()).toEqual(['setup', 'workspace-ready', 'init-empty-project', 'set-default-project']);
    expect(ops()).not.toContain('clone-project');
    expect(ops()).not.toContain('validate-project-name');
    // Nothing was fetched, so there is nothing to scan — no index step, no row.
    expect(ops()).not.toContain('index-project');
    expect(rows(result)).toEqual(['launch', 'health', 'init', 'default', 'open']);
    // Still the project the box opens on — but that is now the BOX's doing, set
    // via set-default-project, not something encoded in the url. open-service
    // takes no landing path.
    expect(bodyOf('set-default-project')?.project_id).toBe(PROJECT_ID);
    expect(h.openedUrl).toContain('/open-service/workspace');
    expect(h.openedUrl).not.toContain(PROJECT_ID);
  });

  it('shows the rows the launch will actually run, not a fixed list', async () => {
    const result = await launchWithGit();

    // A git-backed project can declare context projects only the clone reveals,
    // so its `context` row is planned even when none turn up.
    expect(rows(result)).toEqual(['launch', 'health', 'validate', 'clone', 'index', 'context', 'default', 'open']);
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

  it('creates without booting: one save, and no ops at all', async () => {
    const { result } = renderHook(() => useSandboxes());

    let node: ComputeNode | null = null;
    await act(async () => {
      node = await result.current.createSandbox({ name: 'Sandbox 9', sandboxProject: { name: 'scratch' } });
    });

    // `ops/setup` is what creates a billable VM. A create that runs it charges
    // for a machine the user may never open — the whole reason for the split.
    expect(ops()).toEqual([]);
    expect(node!.node_provider_id).toBeFalsy();
    // What the first launch owes is written down on the node, not held in a
    // dialog: creating with a project and launching from the card days later
    // must still get that project.
    expect(node!.node_config?.pending_setup).toMatchObject({ name: 'scratch' });
  });

  it('launches from what the node was created with, with nothing passed in', async () => {
    answers({ 'init-empty-project': { project: { id: PROJECT_ID }, path: '/root/workspace/scratch' } });
    const { result } = renderHook(() => useSandboxes());

    // A node as the LIST hands it back — the card's Launch button has no dialog
    // state to draw on, only this.
    const node = new ComputeNode({
      id: '11111111-2222-4333-8444-555555555001',
      name: 'Sandbox 9',
      node_config: { flavor: 'workspace', pending_setup: { name: 'scratch' } },
    } as never);

    await act(async () => {
      await result.current.launchSandbox(node);
    });

    expect(ops()).toEqual(['setup', 'workspace-ready', 'init-empty-project', 'set-default-project']);
    expect(bodyOf('set-default-project')?.project_id).toBe(PROJECT_ID);
    // Launching does not open anything: that is the caller's separate click.
    expect(h.openedUrl).toBeNull();
  });

  it('turns auto-login off before the box signs anyone in', async () => {
    const { result } = renderHook(() => useSandboxes());
    const node = new ComputeNode({
      id: '11111111-2222-4333-8444-555555555002',
      name: 'Sandbox 9',
      node_config: { flavor: 'workspace' },
    } as never);

    await act(async () => {
      await result.current.launchSandbox(node, { autoLogin: false });
    });

    const autoLogin = h.calls.findIndex((c) => c.action === 'auto-login');
    const health = h.calls.findIndex((c) => c.op === 'workspace-ready');
    expect(h.calls[autoLogin]?.body).toEqual({ auto_login: false });
    // Order is the point: `workspace-ready` is what signs the box in, so
    // flipping the flag after it would leave the opted-out session running.
    expect(autoLogin).toBeLessThan(health);
  });

  it('does not spend a round trip re-asserting the default', async () => {
    const { result } = renderHook(() => useSandboxes());
    const node = new ComputeNode({
      id: '11111111-2222-4333-8444-555555555003',
      name: 'Sandbox 9',
      node_config: { flavor: 'workspace' },
    } as never);

    await act(async () => {
      await result.current.launchSandbox(node, { autoLogin: true });
    });

    // `true` is the hub's default for a fresh node.
    expect(h.calls.some((c) => c.action === 'auto-login')).toBe(false);
  });

  it('skips every git command when launching a bare sandbox', async () => {
    const { result } = renderHook(() => useSandboxes());
    await act(async () => {
      await result.current.launch({ name: 'Sandbox 2' });
    });

    expect(ops()).toEqual(['setup', 'workspace-ready']);
    expect(h.openedUrl).toContain('/open-service/workspace');
    expect(result.current.steps.map((s) => s.id)).toEqual(['launch', 'health', 'open']);
  });
});
