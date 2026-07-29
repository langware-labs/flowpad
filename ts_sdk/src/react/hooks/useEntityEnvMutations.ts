import { useCallback, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { EntityEnv, EnvVarType, TypeId } from '@sdk';

/**
 * Writes to an entity's env-var table, paired with the cache invalidation they
 * require.
 *
 * The point is the query key. `['entity-env-table', <id>]` is read by
 * {@link useEntityEnv} and was previously re-typed by hand at every call site —
 * five of them in one component — so a rename would have silently left stale
 * tables behind. It is written here and nowhere else.
 *
 * These **rethrow**. Turning a failure into user-facing copy is the UI's job,
 * not the SDK's, and the two consumers word their toasts differently.
 */

export interface EnvVarCreateInput {
  name: string;
  var_type: EnvVarType;
  description?: string;
  value: string;
}

export interface EnvVarUpdateInput {
  var_type?: EnvVarType;
  description?: string;
  value?: string;
}

export interface UseEntityEnvMutations {
  create(input: EnvVarCreateInput): Promise<void>;
  update(name: string, patch: EnvVarUpdateInput): Promise<void>;
  remove(name: string): Promise<void>;
  /** Re-fetch the table without writing — for changes made through another path. */
  invalidate(): void;
}

export function useEntityEnvMutations(entityTypeId?: TypeId): UseEntityEnvMutations {
  const queryClient = useQueryClient();
  const key = entityTypeId?.toString();

  const invalidate = useCallback(() => {
    if (!key) return;
    void queryClient.invalidateQueries({ queryKey: ['entity-env-table', key] });
  }, [queryClient, key]);

  return useMemo<UseEntityEnvMutations>(() => {
    const requireEntity = (): TypeId => {
      if (!entityTypeId) throw new Error('No entity selected');
      return entityTypeId;
    };

    return {
      invalidate,
      async create(input) {
        await new EntityEnv(requireEntity()).create(input as never);
        invalidate();
      },
      async update(name, patch) {
        await new EntityEnv(requireEntity()).update(name, patch as never);
        invalidate();
      },
      async remove(name) {
        await new EntityEnv(requireEntity()).delete(name);
        invalidate();
      },
    };
  }, [entityTypeId, invalidate]);
}
