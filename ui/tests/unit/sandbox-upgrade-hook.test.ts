/**
 * `upgradeSandbox` — the hook half of upgrading the app inside a box.
 *
 * The whole sequence (`flow stop`, `flow upgrade`, start) lives hub-side behind
 * ONE command, and that is deliberate: the start has to carry the hub url into
 * the process, which a browser cannot do. So what the client owns is exactly
 * this — issue `ops/upgrade-app`, say what came back, and never throw at a click
 * handler. Pinned here because the wire name is the contract with the hub, and
 * because a rejection that escaped would surface as an unhandled promise
 * rejection rather than as anything a user sees.
 */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  ops: [] as string[],
  failing: new Set<string>(),
  result: {} as Record<string, unknown>,
  refetch: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    dataContext: { workspaceTypeId: null },
    dataManager: { save: vi.fn(() => Promise.resolve(undefined)), callAction: vi.fn(() => Promise.resolve({})) },
  };
});

vi.mock('@sdk/react/hooks', () => ({
  useAuth: () => ({ user: { id: 'u1' } }),
  useEntitiesQuery: () => ({ data: [], isLoading: false, refetch: h.refetch }),
}));

vi.mock('@src/notifications', () => ({
  notify: { warning: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

import { ComputeNode } from '@sdk';
import { useSandboxes } from '@src/hooks/use-sandboxes';
import { notify } from '@src/notifications';

// Same seam the other sandbox hook tests use: every `ops/<name>` command goes
// through this one prototype method, so a single spy is the whole conversation.
vi.spyOn(ComputeNode.prototype as unknown as { ops: unknown } as never, 'ops' as never).mockImplementation(((
  op: string,
) => {
  h.ops.push(op);
  return h.failing.has(op) ? Promise.reject(new Error('the box did not answer')) : Promise.resolve(h.result);
}) as never);

let boxes = 0;

function box(): ComputeNode {
  return new ComputeNode({ id: `node-${++boxes}`, name: 'Sandbox One', node_provider_id: 'sbx-1' } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.ops.length = 0;
  h.failing.clear();
  h.result = { upgraded: true, version: '0.2.141', healthy: true };
});

afterEach(() => cleanup());

describe('upgradeSandbox', () => {
  it('runs the hub command, not three commands of its own', async () => {
    const node = box();
    const { result } = renderHook(() => useSandboxes());

    await act(async () => {
      await result.current.upgradeSandbox(node);
    });

    expect(h.ops).toEqual(['upgrade-app']);
    // The list is the honest source for status and for who the box is signed in
    // as, both of which a restart can change.
    expect(h.refetch).toHaveBeenCalled();
  });

  it('names the version the box came back on', async () => {
    const { result } = renderHook(() => useSandboxes());

    await act(async () => {
      await result.current.upgradeSandbox(box());
    });

    expect(notify.success).toHaveBeenCalled();
    const message = String(
      (notify.success as unknown as { mock: { calls: [{ message: string }][] } }).mock.calls[0][0].message,
    );
    expect(message).toContain('0.2.141');
  });

  it('still reports success when the box did not say which version it landed on', async () => {
    // The version is a follow-up read on the box. An upgrade that worked must
    // not be reported as failed because that read came back empty.
    h.result = { upgraded: true, healthy: true };
    const { result } = renderHook(() => useSandboxes());

    await act(async () => {
      await result.current.upgradeSandbox(box());
    });

    expect(notify.success).toHaveBeenCalled();
    expect(notify.error).not.toHaveBeenCalled();
  });

  it('reports a refusal instead of throwing at the click handler', async () => {
    h.failing.add('upgrade-app');
    const { result } = renderHook(() => useSandboxes());

    await act(async () => {
      await result.current.upgradeSandbox(box());
    });

    expect(notify.error).toHaveBeenCalled();
    expect(notify.success).not.toHaveBeenCalled();
    // Nothing changed on the box, so there is nothing to re-read.
    expect(h.refetch).not.toHaveBeenCalled();
  });

  it('clears its spinner whether the upgrade worked or not', async () => {
    h.failing.add('upgrade-app');
    const { result } = renderHook(() => useSandboxes());

    await act(async () => {
      await result.current.upgradeSandbox(box());
    });

    expect(result.current.upgradingId).toBeNull();
  });
});
