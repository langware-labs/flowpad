/**
 * React hook for lazy loading system profile resources.
 *
 * Provides easy access to the ResourceManager with auto-fetch, pagination, and invalidation support.
 */

import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import { type SystemProfileItem } from '@sdk';
import { useCallback, useEffect, useState } from 'react';
import { notify } from '@src/notifications';
import { type ScanParams, type TimeWindow, useResourceManager } from '../store/resource-manager';

interface UseResourcesOptions {
  timeWindow?: TimeWindow;
  parentId?: string;
  limit?: number;
  autoFetch?: boolean; // default true
}

interface UseResourcesResult<T> {
  items: T[];
  isLoading: boolean;
  error: string | null;
  hasMore: boolean;
  totalCount: number;
  fetchMore: () => Promise<void>;
  refresh: () => Promise<void>;
  invalidate: () => void;
}

/**
 * Hook for fetching and managing system profile resources with lazy loading.
 *
 * @param resourceType - The resource type to fetch (e.g., SystemResourceType.HOOK)
 * @param options - Options for filtering, pagination, and auto-fetch
 * @returns Object containing items, loading state, error, and control functions
 *
 * @example
 * ```tsx
 * import { useResources, SystemResourceType } from '@src/hooks/use-resources';
 *
 * // Basic usage
 * const { items: hooks, isLoading } = useResources(SystemResourceType.HOOK);
 *
 * // With time window filtering
 * const { items: recentSessions } = useResources(SystemResourceType.SESSION, {
 *   timeWindow: { start: new Date(Date.now() - 3600000).toISOString() }
 * });
 *
 * // With parent filtering (sessions for a project)
 * const { items: projectSessions } = useResources(SystemResourceType.SESSION, {
 *   parentId: 'my_project_encoded_name'
 * });
 *
 * // With pagination
 * const { items, hasMore, fetchMore } = useResources(SystemResourceType.SESSION, {
 *   limit: 50
 * });
 *
 * // Manual fetch (autoFetch: false)
 * const { items, refresh } = useResources(SystemResourceType.HOOK, {
 *   autoFetch: false
 * });
 * useEffect(() => { refresh(); }, [someCondition]);
 * ```
 */
export function useResources<T extends SystemProfileItem = SystemProfileItem>(
  resourceType: string,
  options: UseResourcesOptions = {},
): UseResourcesResult<T> {
  const { computeNode } = useAgentContext();
  const { timeWindow, parentId, limit = 100, autoFetch = true } = options;

  const [items, setItems] = useState<T[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [totalCount, setTotalCount] = useState(0);
  const [offset, setOffset] = useState(0);

  const { setComputeNodeId, getResources, invalidate: storeInvalidate } = useResourceManager();

  // Initialize resource manager with compute node
  useEffect(() => {
    if (computeNode?.id) {
      setComputeNodeId(computeNode.id);
    }
  }, [computeNode?.id, setComputeNodeId]);

  // Fetch resources
  const fetchResources = useCallback(
    async (fetchOffset = 0, append = false) => {
      if (!computeNode?.id) return;

      setIsLoading(true);
      setError(null);

      try {
        const params: ScanParams = {
          timeWindow,
          parentId,
          limit,
          offset: fetchOffset,
        };

        const result = await getResources<T>(resourceType, params);

        setItems((prev) => (append ? [...prev, ...result] : result));
        setOffset(fetchOffset + result.length);
        // Note: hasMore and totalCount would ideally come from metadata
        // For now we estimate based on whether we got a full page
        setHasMore(result.length >= limit);
        setTotalCount((prev) => (append ? prev : Math.max(prev, fetchOffset + result.length)));
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to fetch resources';
        setError(message);
        notify.error({
          title: `Failed to load ${resourceType.replace(/_/g, ' ')}`,
          message,
        });
      } finally {
        setIsLoading(false);
      }
    },
    [computeNode?.id, resourceType, timeWindow, parentId, limit, getResources],
  );

  // Auto-fetch on mount/params change
  useEffect(() => {
    if (autoFetch && computeNode?.id) {
      void fetchResources(0, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFetch, computeNode?.id, resourceType, timeWindow?.start, timeWindow?.end, parentId]);

  const fetchMore = useCallback(async () => {
    await fetchResources(offset, true);
  }, [fetchResources, offset]);

  const refresh = useCallback(async () => {
    setOffset(0);
    await fetchResources(0, false);
  }, [fetchResources]);

  const invalidate = useCallback(() => {
    storeInvalidate(resourceType);
    setItems([]);
    setOffset(0);
    setTotalCount(0);
    setHasMore(false);
  }, [resourceType, storeInvalidate]);

  return { items, isLoading, error, hasMore, totalCount, fetchMore, refresh, invalidate };
}

// Re-export types and helpers for convenience
export {
  SystemResourceType,
  getSimpleResourceType,
  getSystemResourceType,
  isSystemResourceType,
} from '../store/resource-manager';
export type { ScanParams, TimeWindow } from '../store/resource-manager';
