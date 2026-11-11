import { getHostedRepo } from '@sdk';
import { useQuery } from '@tanstack/react-query';

/** The project's hub-hosted repo (null when it has none), shared by the Git button and the Git view. */
export function useHostedRepo(projectId: string) {
  return useQuery({
    queryKey: ['hosted-repo', projectId],
    queryFn: () => getHostedRepo(projectId),
    staleTime: 60_000,
  });
}
