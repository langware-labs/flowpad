import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import { fetchSystemProfileFromComputeNode, type SystemProfile } from '@sdk';
import { useCallback, useEffect, useRef, useState } from 'react';

interface UseSystemProfileOptions {
  /** When true, bypasses cache and fetches fresh data */
  noCache?: boolean;
  /** When true, skips fetching entirely (returns null data) */
  skip?: boolean;
}

interface UseSystemProfileResult {
  data: SystemProfile | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

/** Cache TTL in milliseconds (1 minute) */
const CACHE_TTL = 60000;

/**
 * Hook for fetching and caching system profile data from the compute node.
 *
 * @param options - Options for controlling cache behavior
 * @param options.noCache - When true, bypasses cache and fetches fresh data
 * @returns Object containing data, loading state, error, and refetch function
 *
 * @example
 * ```tsx
 * // Default usage with caching
 * const { data, isLoading, error, refetch } = useSystemProfile();
 *
 * // Force fresh data (no cache)
 * const { data } = useSystemProfile({ noCache: true });
 * ```
 */
export function useSystemProfile(options: UseSystemProfileOptions = {}): UseSystemProfileResult {
  const { computeNode } = useAgentContext();
  const [data, setData] = useState<SystemProfile | null>(null);
  const [isLoading, setIsLoading] = useState(!options.skip);
  const [error, setError] = useState<string | null>(null);
  const cacheRef = useRef<{ data: SystemProfile; timestamp: number } | null>(null);

  const fetchData = useCallback(async () => {
    // Skip fetching if skip option is true
    if (options.skip) {
      setIsLoading(false);
      return;
    }

    if (!computeNode?.id) {
      setIsLoading(false);
      setError('No compute node available');
      return;
    }

    // Check cache if noCache is false (default)
    if (!options.noCache && cacheRef.current) {
      const age = Date.now() - cacheRef.current.timestamp;
      if (age < CACHE_TTL) {
        setData(cacheRef.current.data);
        setIsLoading(false);
        return;
      }
    }

    setIsLoading(true);
    setError(null);

    try {
      const profile = await fetchSystemProfileFromComputeNode(computeNode.id);
      setData(profile);
      cacheRef.current = { data: profile, timestamp: Date.now() };
    } catch (err) {
      console.error('Failed to fetch system profile:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch system profile');
    } finally {
      setIsLoading(false);
    }
  }, [computeNode?.id, options.noCache, options.skip]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  return { data, isLoading, error, refetch: fetchData };
}
