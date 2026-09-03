import { useQuery } from '@tanstack/react-query';
import { connectionsService, type TypeId } from '@sdk';

export const CONNECTIONS_KEY = ['connections'] as const;

/**
 * Every connection this box has, as one cached read.
 *
 * One request where the screen used to make eight — and, more to the point, one
 * definition of "connected". Folding four shapes in the browser is what let the
 * Connections table and the LLM sources screen disagree about the same key.
 *
 * `null` means the hub: device logins, stored keys and OAuth grants are box
 * facts, so the action does not exist there and the caller renders nothing
 * rather than an empty-looking box.
 */
export function useConnections(projectTypeId?: TypeId | null) {
  const projectId = projectTypeId?.id ?? '';
  const { data, isLoading, refetch } = useQuery({
    queryKey: [...CONNECTIONS_KEY, projectId],
    queryFn: () => connectionsService.list(projectId || undefined),
    staleTime: 10_000,
  });
  return { connections: data ?? null, isLoading, refetch };
}
