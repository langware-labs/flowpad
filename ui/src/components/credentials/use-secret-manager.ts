import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { credentialsService, type SecretVaultList } from '@sdk';

export const SECRET_MANAGER_KEY = ['secret-manager'] as const;

const EMPTY: SecretVaultList = { vaults: {}, rows: [], global: null, active: null };

/**
 * A project's secret manager — its vaults described, the global one and the one in use — as one cache entry
 * per project, shared by every surface. One request; it runs no manager, so reading it never raises an
 * unlock prompt.
 */
export function useSecretManager(projectId: string | null) {
  const query = useQuery({
    queryKey: [...SECRET_MANAGER_KEY, projectId ?? ''],
    queryFn: () => credentialsService.vaultList(projectId as string),
    enabled: !!projectId,
  });
  return { ...query, data: query.data ?? EMPTY };
}

/** Re-read the secret manager everywhere it is shown — after a vault, the default or the global one changed. */
export function useRefreshSecretManager() {
  const qc = useQueryClient();
  return useCallback(() => qc.invalidateQueries({ queryKey: SECRET_MANAGER_KEY }), [qc]);
}
