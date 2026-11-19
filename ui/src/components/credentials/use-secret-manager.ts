import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { credentialsService, type SecretVaultList, type VaultAccessState, type VaultRef } from '@sdk';

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

/** Its own root, not under `SECRET_MANAGER_KEY`: a change to the vault list must not re-ask every manager. */
const accessKey = (projectId: string, vault: VaultRef) => ['vault-access', projectId, vault.scope, vault.name] as const;

/**
 * Whether one vault's access is open on this computer, with a `change` that opens or closes it. The status
 * read asks nothing of the person. It goes stale fast, because a manager seals itself (a timeout, a locked
 * app) without telling anyone.
 */
export function useVaultAccess(projectId: string | null, vault: VaultRef | null) {
  const qc = useQueryClient();
  const on = !!projectId && !!vault;
  const query = useQuery({
    queryKey: on ? accessKey(projectId, vault) : ['vault-access'],
    queryFn: () => credentialsService.vaultAccess(projectId as string, vault as VaultRef),
    enabled: on,
    staleTime: 15_000,
  });
  const change = useCallback(
    async (to: 'open' | 'close') => {
      if (!projectId || !vault) return;
      qc.setQueryData<VaultAccessState>(accessKey(projectId, vault), await credentialsService.vaultAccess(projectId, vault, to));
    },
    [qc, projectId, vault],
  );
  return { access: query.data ?? null, loading: query.isFetching, change };
}

/** Re-read the secret manager everywhere it is shown — after a vault, the default or the global one changed. */
export function useRefreshSecretManager() {
  const qc = useQueryClient();
  return useCallback(() => qc.invalidateQueries({ queryKey: SECRET_MANAGER_KEY }), [qc]);
}
