import { QueryClient } from '@tanstack/query-core';

/** Shared by the headless SDK and the application's QueryClientProvider. */
export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5 * 60 * 1000, refetchOnWindowFocus: false, retry: 1 } },
});
