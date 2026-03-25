import { authManager, config } from '@sdk';
import { useQuery } from '@tanstack/react-query';

/**
 * Hook to refresh authentication token
 *
 * This hook uses query-specific options that override the default QueryClient settings:
 * - Refetches every 2 hours (refetchInterval)
 * - Refetches when window regains focus (refetchOnWindowFocus: true)
 *
 * The existing QueryClient remains unchanged with refetchOnWindowFocus: false
 *
 * Set CHECK_REFRESH_TOKEN config to false to disable automatic token refresh.
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const { data, isLoading, error } = useGlobalEvents();
 *   // Token will automatically refresh every 2 hours and on window focus (if enabled)
 * }
 * ```
 */
export function useGlobalEvents() {
  return useQuery({
    queryKey: ['refresh-token'],
    queryFn: async () => {
      const result = await authManager.refreshToken();
      return result;
    },
    // Override default QueryClient settings for this specific query
    refetchOnWindowFocus: true, // Refresh when window regains focus
    refetchInterval: 2 * 60 * 60 * 1000, // Refresh every 2 hours
    retry: 1,
    enabled: config.CHECK_REFRESH_TOKEN, // Disable query if check_refresh_token is false
  });
}
