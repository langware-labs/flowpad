/**
 * `useEntityEnvMutations` — writes paired with the one cache key they invalidate.
 *
 * The key `['entity-env-table', <id>]` was previously re-typed by hand at five
 * call sites in one component. This pins that it is written once, and that
 * failures reach the caller instead of being swallowed into a toast the SDK
 * has no business wording.
 */
import { act, cleanup, render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('@sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  EntityEnv: class {
    create = h.create;
    update = h.update;
    delete = h.remove;
  },
}));

import { useEntityEnvMutations, type UseEntityEnvMutations } from '@sdk/react/hooks';

const PROJECT_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const TYPE_ID = { type: 'project', id: PROJECT_ID, toString: () => `project-${PROJECT_ID}` };

function renderHook(typeId: unknown = TYPE_ID) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const captured: { current: UseEntityEnvMutations | null } = { current: null };
  const Probe = () => {
    captured.current = useEntityEnvMutations(typeId as never);
    return null;
  };
  render(
    <QueryClientProvider client={client}>
      <Probe />
    </QueryClientProvider>,
  );
  return { captured, invalidate };
}

describe('useEntityEnvMutations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks keeps implementations; a rejection set by one test would
    // otherwise fire in the next.
    h.create.mockReset();
    h.update.mockReset();
    h.remove.mockReset();
  });
  afterEach(() => cleanup());

  it('invalidates exactly the entity-env-table key, once per write', async () => {
    const { captured, invalidate } = renderHook();

    await act(async () => {
      await captured.current!.create({ name: 'A_KEY', var_type: 'api_key' as never, value: 'v' });
    });

    expect(h.create).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['entity-env-table', `project-${PROJECT_ID}`] });
  });

  it('invalidates after update and after remove too', async () => {
    const { captured, invalidate } = renderHook();

    await act(async () => {
      await captured.current!.update('A_KEY', { description: 'd' });
      await captured.current!.remove('A_KEY');
    });

    expect(h.update).toHaveBeenCalledWith('A_KEY', { description: 'd' });
    expect(h.remove).toHaveBeenCalledWith('A_KEY');
    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it('rethrows so the UI can word its own message', async () => {
    h.remove.mockRejectedValue(new Error('backend said no'));
    const { captured, invalidate } = renderHook();

    await expect(captured.current!.remove('A_KEY')).rejects.toThrow('backend said no');
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('refuses to write with no entity, and never invalidates', async () => {
    const { captured, invalidate } = renderHook(null);

    await expect(captured.current!.remove('A_KEY')).rejects.toThrow(/No entity/);
    expect(h.remove).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });
});
