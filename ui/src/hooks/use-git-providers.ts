import {
  type BranchSummary,
  getBranches,
  getInvitations,
  getRepos,
  type GitProvider,
  type RepoInvitation,
  type RepoSummary,
  respondInvitation,
} from '@sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

// 5 minutes — repo lists rarely change within a session; user can manually
// refetch via the picker's refresh button.
const REPO_STALE_MS = 5 * 60 * 1000;

export function useGitRepos(provider: GitProvider, enabled: boolean = true) {
  return useQuery<RepoSummary[]>({
    queryKey: ['git-repos', provider],
    queryFn: () => getRepos(provider),
    staleTime: REPO_STALE_MS,
    enabled,
  });
}

export function useGitBranches(
  repo: { provider: GitProvider; owner: string; name: string } | null,
) {
  return useQuery<BranchSummary[]>({
    queryKey: ['git-branches', repo?.provider, repo?.owner, repo?.name],
    queryFn: () => getBranches(repo!),
    staleTime: REPO_STALE_MS,
    enabled: !!repo,
  });
}

export function useGitInvitations(provider: GitProvider, enabled: boolean = true) {
  return useQuery<RepoInvitation[]>({
    queryKey: ['git-invitations', provider],
    queryFn: () => getInvitations(provider),
    staleTime: REPO_STALE_MS,
    enabled,
  });
}

/**
 * Mutation hook for accept/decline. Invalidates both invitations + repos
 * (an accepted invite adds to the repo list).
 */
export function useRespondInvitation(provider: GitProvider) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: number; action: 'accept' | 'decline' }) =>
      respondInvitation(provider, id, action),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['git-invitations', provider] });
      void queryClient.invalidateQueries({ queryKey: ['git-repos', provider] });
    },
  });
}
