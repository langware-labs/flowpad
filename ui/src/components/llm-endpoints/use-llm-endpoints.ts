/**
 * Data hooks for the LLM endpoints screens.
 *
 * The list is a live entity query with `permissions` expanded, so each row can
 * answer `readOnly` / `canDelete` and the admin controls gate off the hub's
 * answer rather than a client-side guess. Chain/usage/models are read-only
 * action calls, wrapped in react-query for caching + refetch; they are keyed by
 * endpoint id and, for usage, the requested range.
 */
import {
  LLMEndpoint,
  QueryRequest,
  llmEndpointsService,
  lmKeysService,
  type LMApiProvider,
  type LLMUsageQuery,
} from '@sdk';
import { useEntitiesQuery } from '@sdk/react/hooks';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';

import { API_FAMILY, LLM_FAMILY, useEndpointFamily, type EndpointFamily } from './endpoint-family';
import { endpointIdFromTypeId } from './llm-endpoints-pointer';

/** Global by construction — an endpoint is a hub-wide resource, not a project's. One request per
 *  family, built once: a fresh object per render would re-subscribe the live query. */
const ENDPOINTS_QUERY: Record<string, QueryRequest> = Object.fromEntries(
  [LLM_FAMILY, API_FAMILY].map((family) => [
    family.id,
    new QueryRequest({
      type: family.type,
      query: { expand: ['permissions'] },
      scope: [],
      name: `${family.queryKey}s:list`,
    }),
  ]),
);

export function useLlmEndpoints({
  enabled = true,
  family: given,
}: { enabled?: boolean; family?: EndpointFamily } = {}) {
  const contextFamily = useEndpointFamily();
  const family = given ?? contextFamily;
  const { data, isLoading, refetch, error } = useEntitiesQuery<LLMEndpoint>(ENDPOINTS_QUERY[family.id], { enabled });
  // Endpoints usable through the `authenticated_role` stamp (the global root) carry no role edge
  // to this user, so the entity query does not list them; the hub's catalog does. Rows the user
  // holds a role on win (they carry the permission expansion).
  const shared = useQuery({
    queryKey: [family.queryKey, 'shared'],
    queryFn: () => family.service.listShared(),
    staleTime: 60_000,
    // The catalog (endpoints open to every signed-in user) is an LLM endpoint notion.
    enabled: enabled && family.llm,
  });
  const endpoints = useMemo(() => {
    const byId = new Map<string, LLMEndpoint>();
    for (const row of (family.llm && shared.data) || []) if (row.id) byId.set(row.id, row);
    // Only this family's rows: for one render after the switch the live query still holds the other's.
    for (const row of data ?? []) if (row.id && row.getType() === family.type) byId.set(row.id, row);
    return [...byId.values()].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }, [data, shared.data, family.type]);
  const refetchShared = shared.refetch;
  const hasCatalog = family.llm;
  const refetchAll = useCallback(async () => {
    // `refetch` runs a disabled query too, so the catalog is asked for only where there is one.
    await Promise.all([refetch(), ...(hasCatalog ? [refetchShared()] : [])]);
  }, [refetch, refetchShared, hasCatalog]);
  return { endpoints, isLoading: isLoading || shared.isLoading, refetch: refetchAll, error: error ?? shared.error };
}

/**
 * One endpoint out of the list, by bare uuid OR by typeid — the hub hands out
 * `llm_endpoint-<uuid>` in chain hops, `sources` and the token plan, while the
 * entity's own `id` is bare. Normalising here is the reason callers must not
 * hand-roll `endpoints.find((e) => e.id === someId)`: that comparison silently
 * never matches for a typeid.
 */
export function useLlmEndpoint(idOrTypeId: string | null | undefined): LLMEndpoint | null {
  const { endpoints } = useLlmEndpoints();
  const id = idOrTypeId ? endpointIdFromTypeId(idOrTypeId) : null;
  return useMemo(() => (id ? (endpoints.find((e) => e.id === id) ?? null) : null), [endpoints, id]);
}

export function useLlmEndpointChain(id: string | undefined) {
  const family = useEndpointFamily();
  return useQuery({
    queryKey: [family.queryKey, id, 'chain'],
    queryFn: () => family.service.getChain(id as string),
    enabled: !!id,
    staleTime: 15_000,
  });
}

export function useLlmEndpointModels(id: string | undefined) {
  const family = useEndpointFamily();
  return useQuery({
    queryKey: ['llm-endpoint', id, 'models'],
    queryFn: () => llmEndpointsService.listModels(id as string),
    enabled: !!id && family.llm,
    staleTime: 60_000,
  });
}

export function useLlmEndpointModelConfig(id: string | undefined) {
  const family = useEndpointFamily();
  return useQuery({
    queryKey: ['llm-endpoint', id, 'model-config'],
    queryFn: () => llmEndpointsService.getModelConfig(id as string),
    enabled: !!id && family.llm,
  });
}

/** Local catalogs use the same configured source that Test and invocation use. */
export function useLocalEndpointModels(provider: string | undefined) {
  return useQuery({
    queryKey: ['lm-keys', provider, 'models'],
    queryFn: () => lmKeysService.listModels(provider as LMApiProvider),
    enabled: !!provider,
  });
}

/** The sizes each provider declares. The same answer for every endpoint, so it is cached once, not per row. */
export function useLlmProviderSizes(id: string | undefined) {
  return useQuery({
    queryKey: ['llm-endpoint', 'provider-sizes'],
    queryFn: () => llmEndpointsService.listProviderSizes(id as string),
    enabled: !!id,
    staleTime: Infinity,
  });
}

/** Key + fetcher for one endpoint's usage over `query` — shared by the detail's
 *  Usage tab and the list's Today column, so the two hit one cache entry. */
export function usageQueryOptions(id: string, query: LLMUsageQuery, family: EndpointFamily = LLM_FAMILY) {
  return {
    queryKey: [family.queryKey, id, 'usage', query.from, query.to, query.granularity, query.by ?? ''] as const,
    queryFn: () => family.service.getUsage(id, query),
    staleTime: 15_000,
  };
}

export function useLlmEndpointUsage(id: string | undefined, query: LLMUsageQuery | null) {
  // Disabled until both are known; the placeholder key is never fetched.
  const family = useEndpointFamily();
  return useQuery({
    ...usageQueryOptions(id ?? '', query ?? { from: 0, to: 0, granularity: 'day' }, family),
    enabled: !!id && !!query,
  });
}
