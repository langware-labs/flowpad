import { lazyAssets, LazyAsset } from '@sdk/lazy';
import { useLazyAsset } from '@sdk/react/hooks/useLazyAsset';
import {
  createPrivateRepo,
  type GitOrigin,
  type GitProvider,
  respondInvitation,
} from '@sdk';
import { useMutation, useQueryClient } from '@tanstack/react-query';

export function useGitRepos(provider: GitProvider, enabled = true) {
  return useLazyAsset(LazyAsset.GitRepos, { provider }, { enabled });
}

export function useCreateGitRepo(provider: GitProvider) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => createPrivateRepo(provider, name),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: lazyAssets.key(LazyAsset.GitRepos, { provider }) });
    },
  });
}

export function useGitBranches(repo: { git_origin: GitOrigin } | null) {
  return useLazyAsset(LazyAsset.GitBranches, repo ?? undefined, { enabled: !!repo });
}

export function useGitInvitations(provider: GitProvider, enabled = true) {
  return useLazyAsset(LazyAsset.GitInvitations, { provider }, { enabled });
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
      void queryClient.invalidateQueries({ queryKey: lazyAssets.key(LazyAsset.GitInvitations, { provider }) });
      void queryClient.invalidateQueries({ queryKey: lazyAssets.key(LazyAsset.GitRepos, { provider }) });
    },
  });
}
