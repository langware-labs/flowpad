import { Project } from '@sdk';
import { useAuth } from '@sdk/react/hooks/useAuth';
import { useLazyAsset, type UseLazyAssetOptions } from '@sdk/react/hooks/useLazyAsset';
import { LazyAsset } from '@sdk/lazy';
import { useMemo } from 'react';

/** Canonical live project collection; widgets wait until the primary view is ready. */
export const useProjects = (options: UseLazyAssetOptions = {}) => {
  const { user } = useAuth();
  const result = useLazyAsset(LazyAsset.Projects, undefined, {
    priority: 'background', ...options, enabled: !!user && options.enabled !== false,
  });
  const projects = useMemo(() => result.data?.slice().sort(Project.compare('updated_date')), [result.data]);
  return { projects, isLoading: result.isLoading, error: result.error, refetch: result.reload };
};
