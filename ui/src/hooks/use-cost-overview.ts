/**
 * React hook for fetching cost overview data from a compute node.
 *
 * Uses the SDK's fetchCostOverviewFromComputeNode to get comprehensive cost data
 * aggregated by time windows, model, and project.
 */

import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import { fetchCostOverviewFromComputeNode, type CostOverview } from '@sdk';
import { useCallback, useEffect, useMemo, useState } from 'react';

interface UseCostOverviewOptions {
  sessionLimit?: number;
  autoFetch?: boolean;
  staleTimeMs?: number;
}

interface UseCostOverviewResult {
  data: CostOverview | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

interface CostOverviewCacheEntry {
  data: CostOverview;
  timestamp: number;
}

const DEFAULT_COST_OVERVIEW_STALE_TIME_MS = 2 * 60 * 1000;
const costOverviewCache = new Map<string, CostOverviewCacheEntry>();
const costOverviewInFlight = new Map<string, Promise<CostOverview>>();

/**
 * Hook for fetching cost overview data from a compute node.
 *
 * @param options - Options for session limit and auto-fetch behavior
 * @returns Object containing cost data, loading state, error, and refetch function
 *
 * @example
 * ```tsx
 * const { data, isLoading, error, refetch } = useCostOverview();
 *
 * // With options
 * const { data } = useCostOverview({ sessionLimit: 200, autoFetch: false });
 * ```
 */
export function useCostOverview(options: UseCostOverviewOptions = {}): UseCostOverviewResult {
  const { computeNode } = useAgentContext();
  const { sessionLimit = 100, autoFetch = true, staleTimeMs = DEFAULT_COST_OVERVIEW_STALE_TIME_MS } = options;

  const [data, setData] = useState<CostOverview | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(
    async (forceRefresh = false) => {
      if (!computeNode?.id) return;

      const cacheKey = `${computeNode.id}:${sessionLimit}`;

      if (!forceRefresh) {
        const cached = costOverviewCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < staleTimeMs) {
          setData(cached.data);
          setIsLoading(false);
          setError(null);
          return;
        }
      }

      setIsLoading(true);
      setError(null);

      try {
        let pending = costOverviewInFlight.get(cacheKey);
        if (!pending || forceRefresh) {
          pending = fetchCostOverviewFromComputeNode(computeNode.id, sessionLimit);
          costOverviewInFlight.set(cacheKey, pending);
        }

        const result = await pending;
        costOverviewCache.set(cacheKey, { data: result, timestamp: Date.now() });
        setData(result);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to fetch cost overview');
      } finally {
        costOverviewInFlight.delete(cacheKey);
        setIsLoading(false);
      }
    },
    [computeNode?.id, sessionLimit, staleTimeMs],
  );

  useEffect(() => {
    if (autoFetch && computeNode?.id) {
      void fetchData(false);
    }
  }, [autoFetch, computeNode?.id, fetchData]);

  const refetch = useCallback(() => fetchData(true), [fetchData]);

  return {
    data,
    isLoading,
    error,
    refetch,
  };
}
