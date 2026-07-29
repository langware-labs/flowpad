import { useCallback, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { EntityEnv, EnvVar, TypeId } from '@sdk';

import { entityEnvQueryKey } from './useEntityEnv';

/**
 * Writes to an entity's env-var table, paired with the cache invalidation they
 * require.
 *
 * The point is the invalidation. Every write has to land on the same cache
 * entry {@link useEntityEnv} reads, and that pairing was previously re-typed by
 * hand at every call site — five of them in one component — so a write added
 * without one left a stale table behind. The key itself lives in
 * {@link entityEnvQueryKey}.
 *
 * These **rethrow**. Turning a failure into user-facing copy is the UI's job,
 * not the SDK's, and the two consumers word their toasts differently.
 */

export interface UseEntityEnvMutations {
  create(input: EnvVar): Promise<void>;
  update(name: string, patch: Partial<EnvVar>): Promise<void>;
  remove(name: string): Promise<void>;
  /** Re-fetch the table without writing — for changes made through another path. */
  invalidate(): void;
}

export function useEntityEnvMutations(entityTypeId?: TypeId): UseEntityEnvMutations {
  const queryClient = useQueryClient();
  const key = entityTypeId?.toString();

  const invalidate = useCallback(() => {
    if (!key) return;
    void queryClient.invalidateQueries({ queryKey: entityEnvQueryKey(entityTypeId) });
    // `key` is the invalidation's real identity; entityTypeId rides along for the
    // key builder and is stable whenever key is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryClient, key]);

  return useMemo<UseEntityEnvMutations>(() => {
    const requireEntity = (): TypeId => {
      if (!entityTypeId) throw new Error('No entity selected');
      return entityTypeId;
    };

    return {
      invalidate,
      async create(input) {
        await new EntityEnv(requireEntity()).create(input);
        invalidate();
      },
      async update(name, patch) {
        await new EntityEnv(requireEntity()).update(name, patch);
        invalidate();
      },
      async remove(name) {
        await new EntityEnv(requireEntity()).delete(name);
        invalidate();
      },
    };
  }, [entityTypeId, invalidate]);
}
