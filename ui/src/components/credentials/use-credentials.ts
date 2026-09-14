import { useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CredentialSpec, QueryRequest, credentialsService, EMPTY_CREDENTIALS_STATUS } from '@sdk';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';

/**
 * Every CredentialSpec row. Global on purpose: the shipped templates are a
 * property of the instance, not of a project — the picker keeps only those, and
 * the declared credentials come from `status` instead.
 */
const credentialSpecsQuery = new QueryRequest({
  type: CredentialSpec.type,
  scope: [],
  name: 'connections:credential-specs',
});

const NO_SPECS: CredentialSpec[] = [];

export const CREDENTIALS_STATUS_KEY = ['credentials-status'] as const;

/**
 * The credentials the user and (optionally) a project declare, and the shipped
 * templates that can be added.
 *
 * `status` is value-free: names, presence, and what each scope's `.env.local`
 * holds. It refetches when the window regains focus — fixing `.gitignore` or a
 * `.env.local` elsewhere shows up on return — and `refresh` invalidates it after
 * a write.
 */
export function useCredentials(projectId: string | null) {
  const { data: specs = NO_SPECS } = useEntitiesQuery<CredentialSpec>(credentialSpecsQuery);
  const templates = useMemo(() => specs.filter((spec) => spec.isTemplate), [specs]);

  const { data, isPending } = useQuery({
    queryKey: [...CREDENTIALS_STATUS_KEY, projectId ?? ''],
    queryFn: () => credentialsService.status(projectId),
    refetchOnWindowFocus: true,
  });

  const qc = useQueryClient();
  const refresh = useCallback(() => qc.invalidateQueries({ queryKey: CREDENTIALS_STATUS_KEY }), [qc]);

  return { status: data ?? EMPTY_CREDENTIALS_STATUS, templates, ready: !isPending, refresh } as const;
}
