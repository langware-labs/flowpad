/**
 * `useUserApiKeys` — the user's API keys, previously implemented twice.
 *
 * The two copies had drifted: one deleted by id and the other by name, and only
 * one toasted on success. This pins the merged behaviour, and in particular
 * that deletion forwards the **id** — the endpoint keys on it, so the name
 * variant silently did nothing.
 */
import { act, cleanup, render } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ActionInfo validates the type-id, so this must be a real uuid.
const USER_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const USER_TYPE_ID = { type: 'user', id: USER_ID };

const h = vi.hoisted(() => ({
  callAction: vi.fn(),
  generateSelfKey: vi.fn(),
  deleteById: vi.fn(),
  notifyError: vi.fn(),
  notifySuccess: vi.fn(),
  user: { typeId: { type: 'user', id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' } } as { typeId: unknown } | null,
}));

// Partial mock: the import chain pulls in far more of @sdk than this hook uses,
// so replace only the three seams it actually calls.
vi.mock('@sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ApiKey: { generateSelfKey: h.generateSelfKey, deleteById: h.deleteById },
  dataManager: { callAction: h.callAction },
}));
vi.mock('@sdk/react/hooks', () => ({ useAuth: () => ({ user: h.user }) }));
vi.mock('@src/notifications', () => ({
  notify: { error: h.notifyError, success: h.notifySuccess },
}));

import { useUserApiKeys, type UseUserApiKeys } from '@src/components/api-keys-view/use-user-api-keys';

const ACTIVE = { id: 'k1', name: 'FLOWPAD_API_KEY', visible_value: '****abcd', target_typeid: `user-${USER_ID}`, is_active: true };
const REVOKED = { id: 'k0', name: 'FLOWPAD_API_KEY', visible_value: '****old0', target_typeid: `user-${USER_ID}`, is_active: false };

function renderHook(opts?: { onMutated?: () => void }) {
  const captured: { current: UseUserApiKeys | null } = { current: null };
  const Probe = () => {
    captured.current = useUserApiKeys(opts);
    return null;
  };
  render(<Probe />);
  return captured;
}

describe('useUserApiKeys', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.user = { typeId: USER_TYPE_ID };
    h.callAction.mockResolvedValue([ACTIVE]);
    h.generateSelfKey.mockResolvedValue({ api_key: 'sk-generated' });
    h.deleteById.mockResolvedValue(undefined);
  });
  afterEach(() => cleanup());

  it('loads the user’s keys', async () => {
    const hook = renderHook();
    await act(async () => {});

    expect(hook.current?.apiKeys).toEqual([ACTIVE]);
  });

  it('derives flowpadKey and ignores a revoked one', async () => {
    h.callAction.mockResolvedValue([REVOKED]);
    const hook = renderHook();
    await act(async () => {});

    expect(hook.current?.flowpadKey).toBeUndefined();
  });

  it('deletes by ID, not by name', async () => {
    const hook = renderHook();
    await act(async () => {});

    // The reload that follows a delete is authoritative, so let the server
    // reflect it — asserting the optimistic frame alone would pin a state the
    // very next render overwrites.
    h.callAction.mockResolvedValue([]);
    await act(async () => {
      await hook.current!.remove('k1');
    });

    expect(h.deleteById).toHaveBeenCalledWith(USER_TYPE_ID, 'k1');
    expect(hook.current?.apiKeys).toEqual([]);
  });

  it('surfaces the generated secret exactly once, then clears it on delete', async () => {
    const hook = renderHook();
    await act(async () => {});

    await act(async () => {
      await hook.current!.generate();
    });
    expect(hook.current?.generatedKey).toEqual({ api_key: 'sk-generated' });

    await act(async () => {
      await hook.current!.remove('k1');
    });
    expect(hook.current?.generatedKey).toBeNull();
  });

  it('notifies onMutated after both mutations', async () => {
    const onMutated = vi.fn();
    const hook = renderHook({ onMutated });
    await act(async () => {});

    await act(async () => {
      await hook.current!.generate();
    });
    await act(async () => {
      await hook.current!.remove('k1');
    });

    expect(onMutated).toHaveBeenCalledTimes(2);
  });

  it('reports a failure instead of throwing at the caller', async () => {
    h.deleteById.mockRejectedValue({ response: { data: { detail: 'nope' } } });
    const hook = renderHook();
    await act(async () => {});

    await act(async () => {
      await hook.current!.remove('k1');
    });

    expect(h.notifyError).toHaveBeenCalledWith(expect.objectContaining({ message: 'nope' }));
  });

  it('refuses to mutate with no signed-in user', async () => {
    h.user = null;
    const hook = renderHook();
    await act(async () => {});

    await act(async () => {
      await hook.current!.generate();
    });

    expect(h.generateSelfKey).not.toHaveBeenCalled();
    expect(h.notifyError).toHaveBeenCalled();
  });
});
