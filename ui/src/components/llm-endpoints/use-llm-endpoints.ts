/**
 * Data hooks for the LLM endpoints screens.
 *
 * The list is a live entity query with `permissions` expanded, so each row can
 * answer `readOnly` / `canDelete` and the admin controls gate off the hub's
 * answer rather than a client-side guess. Chain/usage/models are read-only
 * action calls, wrapped in react-query for caching + refetch; they are keyed by
 * endpoint id and, for usage, the requested range.
 */
import { LLMEndpoint, QueryRequest, llmEndpointsService, type LLMUsageQuery } from '@sdk';
import { useEntitiesQuery } from '@sdk/react/hooks';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

/** Global by construction — an endpoint is a hub-wide resource, not a project's. */
const ENDPOINTS_QUERY = new QueryRequest({
  type: LLMEndpoint.type,
  query: { expand: ['permissions'] },
  scope: [],
  name: 'llm-endpoints:list',
});

export function useLlmEndpoints() {
  const { data, isLoading, refetch, error } = useEntitiesQuery<LLMEndpoint>(ENDPOINTS_QUERY);
  // Endpoints usable through the `authenticated_role` stamp (the global root) carry no role edge
  // to this user, so the entity query does not list them; the hub's catalog does. Rows the user
  // holds a role on win (they carry the permission expansion).
  const shared = useQuery({
    queryKey: ['llm-endpoint', 'shared'],
    queryFn: () => llmEndpointsService.listShared(),
    staleTime: 60_000,
  });
  const endpoints = useMemo(() => {
    const byId = new Map<string, LLMEndpoint>();
    for (const row of shared.data ?? []) if (row.id) byId.set(row.id, row);
    for (const row of data ?? []) if (row.id) byId.set(row.id, row);
    return [...byId.values()].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }, [data, shared.data]);
  const refetchAll = async () => {
    await Promise.all([refetch(), shared.refetch()]);
  };
  return { endpoints, isLoading: isLoading || shared.isLoading, refetch: refetchAll, error: error ?? shared.error };
}

export function useLlmEndpointChain(id: string | undefined) {
  return useQuery({
    queryKey: ['llm-endpoint', id, 'chain'],
    queryFn: () => llmEndpointsService.getChain(id as string),
    enabled: !!id,
    staleTime: 15_000,
  });
}

export function useLlmEndpointModels(id: string | undefined) {
  return useQuery({
    queryKey: ['llm-endpoint', id, 'models'],
    queryFn: () => llmEndpointsService.listModels(id as string),
    enabled: !!id,
    staleTime: 60_000,
  });
}

/** Key + fetcher for one endpoint's usage over `query` — shared by the detail's
 *  Usage tab and the list's Today column, so the two hit one cache entry. */
export function usageQueryOptions(id: string, query: LLMUsageQuery) {
  return {
    queryKey: ['llm-endpoint', id, 'usage', query.from, query.to, query.granularity, query.by ?? ''] as const,
    queryFn: () => llmEndpointsService.getUsage(id, query),
    staleTime: 15_000,
  };
}

export function useLlmEndpointUsage(id: string | undefined, query: LLMUsageQuery | null) {
  // Disabled until both are known; the placeholder key is never fetched.
  return useQuery({
    ...usageQueryOptions(id ?? '', query ?? { from: 0, to: 0, granularity: 'day' }),
    enabled: !!id && !!query,
  });
}
