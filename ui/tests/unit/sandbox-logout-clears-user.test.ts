/**
 * Signing a sandbox out has to show on the card without a page reload.
 *
 * The bug: the hub sets `logged_in_user` to null, but its API serializer drops
 * every null field, so the refetched compute_node payload has NO
 * `logged_in_user` key — and the store merges a payload key by key, so the
 * cached entity kept the old email. The card went on naming a user who had just
 * been signed out, and only a reload (which builds a fresh entity) told the
 * truth. A refetch therefore cannot be the whole fix, however honest it reads:
 * the wire has no way to say "this is now nothing".
 *
 * Pinned here rather than in the card test because it is the HOOK's job: the
 * card renders whatever the entity says.
 */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  ops: [] as string[],
  /** Ops that reject, standing in for a box that did not confirm. */
  failing: new Set<string>(),
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

vi.mock('@src/notifications', () => ({ notify: { warning: vi.fn(), error: vi.fn() } }));

import { ComputeNode } from '@sdk';
import { useSandboxes } from '@src/hooks/use-sandboxes';

// Same seam as the provisioning test: every `ops/<name>` command goes through
// this one prototype method, so a single spy is the whole conversation.
vi.spyOn(ComputeNode.prototype as unknown as { ops: unknown } as never, 'ops' as never).mockImplementation(((
  op: string,
) => {
  h.ops.push(op);
  // Promises rather than an `async` body: there is nothing to await here, and
  // `require-await` fails the lint gate on a lie about being asynchronous.
  return h.failing.has(op) ? Promise.reject(new Error('the box did not answer')) : Promise.resolve({ status: 'ok' });
}) as never);

// Distinct ids per box: the SDK store registers by id, and re-registering the
// same one from a second test logs a "already registered with different entity".
let boxes = 0;

function signedInBox(): ComputeNode {
  return new ComputeNode({
    id: `node-${++boxes}`,
    name: 'Sandbox One',
    node_provider_id: 'sbx-1',
    logged_in_user: 'ada@example.com',
  } as never);
}

beforeEach(() => {
  h.ops.length = 0;
  h.failing.clear();
  h.refetch.mockClear();
});

afterEach(() => cleanup());

describe('logoutSandbox', () => {
  it('clears the cached user itself — the refetch cannot carry a null', async () => {
    const node = signedInBox();
    const { result } = renderHook(() => useSandboxes());

    await act(async () => {
      await result.current.logoutSandbox(node);
    });

    expect(h.ops).toContain('logout-user');
    // The regression, in one line: this stayed 'ada@example.com' until reload.
    expect(node.logged_in_user).toBeNull();
    // Still refetched — it is what re-renders the list, and the honest source
    // for everything else the sign-out may have changed.
    expect(h.refetch).toHaveBeenCalled();
  });

  it('leaves the user in place when the box did not confirm the sign-out', async () => {
    // Direction matters: a card that says "signed out" about a box still holding
    // a live session is worse than a stale one — it makes the session invisible.
    h.failing.add('logout-user');
    const node = signedInBox();
    const { result } = renderHook(() => useSandboxes());

    await act(async () => {
      await result.current.logoutSandbox(node);
    });

    expect(node.logged_in_user).toBe('ada@example.com');
    expect(h.refetch).not.toHaveBeenCalled();
  });
});
