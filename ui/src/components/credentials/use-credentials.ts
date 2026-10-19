import { useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  recheckProjectReadiness,
  Credential,
  QueryRequest,
  credentialsService,
  EMPTY_CREDENTIALS_STATUS,
} from '@sdk';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import type { DockPointer } from '@src/navigation/DockPointer';

/**
 * Every Credential row. Global on purpose: the shipped templates are a
 * property of the instance, not of a project — the picker keeps only those, and
 * the declared credentials come from `status` instead.
 */
const credentialSpecsQuery = new QueryRequest({
  type: Credential.type,
  scope: [],
  name: 'connections:credential-specs',
});

const NO_SPECS: Credential[] = [];

export const CREDENTIALS_STATUS_KEY = ['credentials-status'] as const;

/** The URL option naming the deployment whose values are shown; absent means this computer. */
export const CREDENTIAL_DEPLOYMENT_OPTION = 'deployment';

/** The deployment `dock` shows credential values for — null is this computer. */
export function credentialDeploymentId(dock: DockPointer | null): string | null {
  return dock?.options?.[CREDENTIAL_DEPLOYMENT_OPTION] || null;
}

/**
 * The value-free credentials status alone — one cache entry per project and
 * deployment, shared by every surface that shows it.
 */
export function useCredentialsStatus(projectId: string | null, deploymentId: string | null = null) {
  return useQuery({
    queryKey: [...CREDENTIALS_STATUS_KEY, projectId ?? '', deploymentId ?? ''],
    queryFn: () => credentialsService.status(projectId, deploymentId),
    refetchOnWindowFocus: true,
  });
}

/**
 * Refetch every credentials status after a write. A value set, a credential changed
 * or an env file declared may be what the project was waiting on: re-check it too.
 */
export function useRefreshCredentials(): () => Promise<void> {
  const qc = useQueryClient();
  return useCallback(async () => {
    await Promise.all([qc.invalidateQueries({ queryKey: CREDENTIALS_STATUS_KEY }), recheckProjectReadiness()]);
  }, [qc]);
}

/**
 * The credentials the user and (optionally) a project declare, and the shipped
 * templates that can be added.
 *
 * `status` is value-free: names, presence, and what each scope's `.env.local`
 * holds. It refetches when the window regains focus — fixing `.gitignore` or a
 * `.env.local` elsewhere shows up on return — and `refresh` invalidates it after
 * a write.
 */
export function useCredentials(projectId: string | null, deploymentId: string | null = null) {
  const { data: specs = NO_SPECS } = useEntitiesQuery<Credential>(credentialSpecsQuery);
  const templates = useMemo(() => specs.filter((spec) => spec.isTemplate), [specs]);

  const { data, isPending } = useCredentialsStatus(projectId, deploymentId);
  const refresh = useRefreshCredentials();

  return { status: data ?? EMPTY_CREDENTIALS_STATUS, templates, ready: !isPending, refresh } as const;
}
