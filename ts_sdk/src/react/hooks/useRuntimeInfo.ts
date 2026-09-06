import { LazyAsset } from '../../lazy';
import { useLazyAsset } from './useLazyAsset';

/** Optional discovery, scoped to the consuming region rather than SDK readiness. */
export function useRuntimeInfo() {
  return useLazyAsset(LazyAsset.RuntimeInfo, undefined, { priority: 'background' });
}
