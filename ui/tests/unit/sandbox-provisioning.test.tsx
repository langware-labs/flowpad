/**
 * Setting a sandbox up = lifecycle ops, then ONE `provision-project`.
 *
 * The box commands (validate, clone, index, attach, default) are the hub's
 * control plane and are not reachable from a browser: the hub runs the
 * sequence (`compute_node_tools.provision_project`, pinned hub-side by
 * `test_provision_project.py`) and reports each step. This hook sends the
 * recorded setup, paints the checklist from the reported steps, and decides
 * what the tab finally opens.
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
import { AxiosError } from 'axios';
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

/** What the hub answers for a provisioning run whose listed steps all succeeded. */
function provisioned(ids: string[], details: Record<string, string> = {}) {
  return {
    project: { id: PROJECT_ID },
    path: '/root/workspace/flowpad-hub',
    steps: ids.map((id) => ({ id, ok: true, detail: details[id] ?? '' })),
  };
}

/** The hub refuses a provisioning run, naming the steps it got through and the one that broke. */
function provisionFails(message: string, steps: Array<{ id: string; ok: boolean; detail: string }>): void {
  h.responses.set('provision-project', () =>
    Promise.reject(
      new AxiosError(message, 'ERR_BAD_REQUEST', undefined, undefined, {
        data: { status: 'FAIL', message, data: { steps } },
        status: 400,
        statusText: 'Bad Request',
        headers: {},
        config: {} as never,
      }),
    ),
  );
}

beforeEach(() => {
  h.calls.length = 0;
  h.responses.clear();
  h.openedUrl = null;
  answers({
    setup: 'provider-1',
    'workspace-ready': { healthy: true, logged_in: true, login_detail: 'someone' },
    'provision-project': provisioned(['validate', 'clone', 'index', 'default']),
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

describe('sandbox provisioning asks the hub for the outcome', () => {
  it('creates the node on the provider selected by Hub bootstrap', async () => {
    await launchWithoutRepo();

    expect(dataManager.save).toHaveBeenCalledWith(
      expect.anything(),
      [],
      expect.objectContaining({ node_provider: 'gcp_vm' }),
    );
  });

  it('boots, signs in, then provisions — one call, no box command from the browser', async () => {
    await launchWithGit();

    expect(ops()).toEqual(['setup', 'workspace-ready', 'provision-project']);
  });

  it('sends the recorded setup in the hub spelling', async () => {
    await launchWithGit({ projectId: PROJECT_ID });

    expect(bodyOf('provision-project')).toEqual({ name: 'flowpad-hub', project_id: PROJECT_ID, git_origin: ORIGIN });
  });

  it('forwards chosen context projects and an install spec', async () => {
    await launchWithGit({
      contextProjects: [{ gitOrigin: ORIGIN, name: 'acme-support', optional: false }],
      install: { kind: 'journey', id: 'onboarding' },
    });

    expect(bodyOf('provision-project')).toMatchObject({
      context_projects: [{ git_origin: ORIGIN, name: 'acme-support', optional: false }],
      install: { kind: 'journey', id: 'onboarding' },
    });
  });

  it('forwards companions — provisioned beside the project, keeping their ids', async () => {
    const companion = '66666666-7777-4888-8999-aaaaaaaaaaaa';
    await launchWithGit({ projectId: PROJECT_ID, companions: [{ gitOrigin: ORIGIN, name: 'q', projectId: companion }] });

    expect(bodyOf('provision-project')).toMatchObject({
      project_id: PROJECT_ID,
      companions: [{ git_origin: ORIGIN, name: 'q', project_id: companion }],
    });
    expect(bodyOf('provision-project')).not.toHaveProperty('context_projects');
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
    // open-service takes no landing path, so a box created with a repo opens on
    // its front door; the box's default project is what lands the user.
    await launchWithGit();

    expect(h.openedUrl).not.toContain(PROJECT_ID);
  });

  it('paints every planned row from the steps the hub reports', async () => {
    answers({
      'provision-project': provisioned(['validate', 'clone', 'index', 'context', 'default'], {
        context: 'acme-support',
      }),
    });

    const result = await launchWithGit();

    const byId = Object.fromEntries(result.current.steps.map((s) => [s.id, s]));
    for (const id of ['validate', 'clone', 'index', 'context', 'default', 'open'])
      expect(byId[id].status).toBe('success');
    expect(byId.context.detail).toBe('acme-support');
  });

  it('marks a planned context row done when the repo declared nothing', async () => {
    const result = await launchWithGit();

    const context = result.current.steps.find((s) => s.id === 'context');
    expect(context?.status).toBe('success');
    expect(context?.detail).toBe('none declared');
  });

  it('shows the step the hub says broke, keeps the ones before, and does not finish', async () => {
    provisionFails('indexer is busy', [
      { id: 'validate', ok: true, detail: '' },
      { id: 'clone', ok: true, detail: '' },
      { id: 'index', ok: false, detail: 'indexer is busy' },
    ]);

    const result = await launchWithGit();

    const byId = Object.fromEntries(result.current.steps.map((s) => [s.id, s]));
    expect(byId.clone.status).toBe('success');
    expect(byId.index.status).toBe('error');
    expect(byId.index.detail).toContain('indexer is busy');
    // Rows after the failure never ran.
    expect(byId.default.status).toBe('idle');
    expect(h.openedUrl).toBeNull();
  });

  it('blames the first row when the failure names no step', async () => {
    h.responses.set('provision-project', () => Promise.reject(new Error('hub unreachable')));

    const result = await launchWithGit();

    const validate = result.current.steps.find((s) => s.id === 'validate');
    expect(validate?.status).toBe('error');
    expect(validate?.detail).toContain('hub unreachable');
  });

  it('mounts a repo-less project: no git origin in the setup, no clone or index rows', async () => {
    answers({ 'provision-project': provisioned(['init', 'default']) });

    const result = await launchWithoutRepo();

    expect(ops()).toEqual(['setup', 'workspace-ready', 'provision-project']);
    expect(bodyOf('provision-project')).toEqual({ name: 'scratch' });
    expect(rows(result)).toEqual(['launch', 'health', 'init', 'default', 'open']);
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
    answers({ 'provision-project': provisioned(['init', 'context', 'default']) });

    const result = await launchWithoutRepo({
      contextProjects: [{ gitOrigin: ORIGIN, name: 'acme-support', optional: false }],
    });

    expect(rows(result)).toContain('context');
    expect(bodyOf('provision-project')).toMatchObject({
      context_projects: [{ git_origin: ORIGIN, name: 'acme-support', optional: false }],
    });
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
    answers({ 'provision-project': provisioned(['init', 'default']) });
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

    expect(ops()).toEqual(['setup', 'workspace-ready', 'provision-project']);
    expect(bodyOf('provision-project')).toEqual({ name: 'scratch' });
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
