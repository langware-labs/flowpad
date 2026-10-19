import { LazyAsset } from '@sdk/lazy';
import { useLazyAsset } from '@sdk/react/hooks/useLazyAsset';

/**
 * The cloud compute providers a deployment may be placed on, as the hub publishes them — one cached
 * read (`LazyAsset.DeployProviders`). Signed out or unreachable, there are none: the hub is what places a
 * cloud deployment, so without it only this computer is offered.
 */
export function useDeployProviders() {
  const { data, isLoading } = useLazyAsset(LazyAsset.DeployProviders);
  return { providers: data ?? [], isLoading };
}
