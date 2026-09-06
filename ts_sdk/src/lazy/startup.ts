import { lazyAssets } from './registry';
import { LazyAsset } from './LazyAsset';
import { defaultScopeFilter } from '../utils/scope-filter';

/** Inspectable startup inventory. Parameterized project resources load only when selected. */
export const startupLazyAssets = [
  LazyAsset.RuntimeInfo, LazyAsset.CloudStatus, LazyAsset.Capabilities, LazyAsset.Projects,
  LazyAsset.AssetCatalog, LazyAsset.Bookmarks, LazyAsset.RagIndexes, LazyAsset.Activities,
  LazyAsset.IndexActivity,
] as const;

/** Called after primary content readiness, never from a route loader. */
export async function prefetchStartupAssets(): Promise<void> {
  const { dataContext } = await import('../FlowSync/context');
  const { isHubOnly } = await import('../utils/hub-runtime');
  const scope = defaultScopeFilter(dataContext.project?.id);
  await Promise.all([
    ...startupLazyAssets.map(asset => lazyAssets.prefetch(asset)),
    lazyAssets.prefetch(LazyAsset.IndexStatus), // Global footer; a separate scoped entry is intentional.
    ...(!isHubOnly() ? [
      lazyAssets.prefetch(LazyAsset.IndexStatus, { scope }),
      lazyAssets.prefetch(LazyAsset.AssetStats, { scope }),
      ...(dataContext.computeNode?.id ? [lazyAssets.prefetch(LazyAsset.DiscoveredProjects, { nodeId: dataContext.computeNode.id })] : []),
    ] : []),
  ]);
}
