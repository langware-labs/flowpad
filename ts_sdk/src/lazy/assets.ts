import apiClient from '../client';
import type { APIEntity } from '../APIEntity';
import type { Project } from '../entities/project';
import type { Bookmark } from '../entities/bookmark';
import type { RagIndex } from '../entities/rag-index';
import type { GitOrigin } from '../models';
import type { GitProvider } from '../services/git-providers';
import { isHubOnly } from '../utils/hub-runtime';
import { scopeFilterKey, scopeToQueryString, type ScopeFilter } from '../utils/scope-filter';
import { defineAsset, type LoadContext } from './definition';
import { LazyAsset } from './LazyAsset';

export interface AssetTypeVault {
  typeid: string; relPath: string; absPath: string; label: string; scope: string;
  project_id?: string | null; record_project_id?: string | null;
}
export interface AssetCatalog { types: { type_name: string; vaults?: AssetTypeVault[] }[] }
export interface IndexStatusPerType {
  type_name: string; last_indexed_at: string | null; entity_count: number; stale: boolean; orphan_count: number;
}
export interface IndexStatus {
  never_indexed: boolean; last_indexed_at: string | null; stale: boolean; default_types: string[];
  per_type: IndexStatusPerType[]; total_orphans: number;
}
export interface AssetStats { per_type: Record<string, number>; total: number }
export interface FavoriteRef { type: string; id: string }
export interface FavoriteSummary { name: string | null; subtitle: string | null }
export interface FavoriteSummaries { summaries: (FavoriteRef & FavoriteSummary)[] }
type NodeParams = { nodeTypeId?: { type: string; id: string } };
const localNode = { type: 'compute_node', id: '@local' };
type Scoped = { scope?: ScopeFilter } | undefined;
const scopeKey = (p: Scoped) => p?.scope ? scopeFilterKey(p.scope) : 'all';
const scopedPath = (path: string, p: Scoped) => {
  const qs = p?.scope ? scopeToQueryString(p.scope) : '';
  return qs ? `${path}?${qs}` : path;
};
export const EMPTY_INDEX_STATUS: IndexStatus = {
  never_indexed: false, last_indexed_at: null, stale: false, default_types: [], per_type: [], total_orphans: 0,
};
export const EMPTY_ASSET_STATS: AssetStats = { per_type: {}, total: 0 };

/** The query store owns entities and live membership; Query caches only their references. */
function entities<T extends APIEntity<T>>(type: string, desktopOnly = false) {
  const request = async (callback?: (rows: T[]) => void) => {
    const { QueryRequest } = await import('../FlowSync/query');
    return new QueryRequest({ type, query: null, scope: [], name: `lazy:${type}`, callback });
  };
  return defineAsset({
    staleTime: Infinity,
    load: async (_: undefined, ctx: LoadContext): Promise<T[]> => {
      if (desktopOnly && isHubOnly()) return [];
      const { dataManager } = await import('../APIEntity');
      const req = await request();
      if (!ctx.isCurrent()) throw new Error('SDK scope changed');
      return dataManager.query<T>(req, true);
    },
    subscribe: async (_: undefined, publish: (data: T[]) => void) => {
      if (desktopOnly && isHubOnly()) return () => {};
      const { dataManager } = await import('../APIEntity');
      const req = await request(rows => publish([...rows]));
      return dataManager.watchQuery<T>(req);
    },
  });
}

/** Each shared read is declared once. Dynamic imports keep SDK singleton initialization acyclic. */
export const assetDefinitions = {
  [LazyAsset.RuntimeInfo]: defineAsset({
    staleTime: Infinity,
    load: async (_: undefined, ctx: LoadContext) => {
      const { fetchDeferredInfo } = await import('../services/deferredInfo');
      return fetchDeferredInfo(ctx);
    },
  }),
  [LazyAsset.CloudStatus]: defineAsset({
    staleTime: Infinity,
    load: async (_: undefined, ctx: LoadContext) => (await import('../services/cloud_login')).cloudManager.fetchStatus(ctx.isCurrent),
  }),
  [LazyAsset.Capabilities]: defineAsset({
    staleTime: Infinity,
    load: async (_: undefined, ctx: LoadContext) => (await import('../capabilities')).capabilityManager.fetchSnapshot(ctx.isCurrent),
  }),
  [LazyAsset.CapabilitySummary]: defineAsset({
    staleTime: Infinity,
    load: async (_: undefined, ctx: LoadContext) => (await import('../capabilities')).capabilityManager.fetchSummary(ctx.isCurrent),
  }),
  [LazyAsset.AssetCatalog]: defineAsset({
    load: async (_: undefined): Promise<AssetCatalog> => isHubOnly() ? { types: [] } :
      (await apiClient.get<AssetCatalog>('/assets/types')) ?? { types: [] },
    subscribe: async (_: undefined) => {
      if (isHubOnly()) return () => {};
      const { subscribeToEntityOps } = await import('../FlowSync/entity-ops');
      const { lazyAssets } = await import('./registry');
      return subscribeToEntityOps('project', () => { void lazyAssets.invalidate(LazyAsset.AssetCatalog); });
    },
  }),
  [LazyAsset.IndexStatus]: defineAsset({
    key: scopeKey,
    load: async (p: Scoped): Promise<IndexStatus> => {
      if (isHubOnly()) return EMPTY_INDEX_STATUS;
      const raw = await apiClient.get<Partial<IndexStatus>>(scopedPath('/graph/compute_node/@local/fs-records/index-status', p));
      const per_type = (raw?.per_type ?? []).map((row) => ({
        type_name: row.type_name, last_indexed_at: row.last_indexed_at ?? null,
        entity_count: row.entity_count ?? 0, stale: row.stale ?? false, orphan_count: row.orphan_count ?? 0,
      }));
      return { ...EMPTY_INDEX_STATUS, ...raw, per_type,
        total_orphans: raw?.total_orphans ?? per_type.reduce((sum, row) => sum + row.orphan_count, 0) };
    },
  }),
  [LazyAsset.AssetStats]: defineAsset({
    key: scopeKey,
    load: async (p: Scoped): Promise<AssetStats> => {
      if (isHubOnly()) return EMPTY_ASSET_STATS;
      const raw = await apiClient.get<Partial<AssetStats>>(scopedPath('/graph/compute_node/@local/fs-records/asset-stats', p));
      const per_type = raw?.per_type ?? {};
      return { per_type, total: raw?.total ?? Object.values(per_type).reduce((sum, n) => sum + n, 0) };
    },
    subscribe: async (p: Scoped, _publish: (data: AssetStats) => void, initial: AssetStats) => {
      const { subscribeToEntityOps } = await import('../FlowSync/entity-ops');
      const { lazyAssets } = await import('./registry');
      return subscribeToEntityOps(Object.keys(initial.per_type), () => {
        void lazyAssets.invalidate(LazyAsset.AssetStats, p ?? {});
      });
    },
  }),
  [LazyAsset.Projects]: entities<Project>('project'),
  [LazyAsset.Bookmarks]: entities<Bookmark>('bookmark', true),
  [LazyAsset.RagIndexes]: entities<RagIndex>('rag_index', true),
  [LazyAsset.DiscoveredProjects]: defineAsset({
    staleTime: 120_000,
    load: async (p: { nodeId: string }, ctx: LoadContext) => {
      const { listProjectsFromComputeNode } = await import('../entities/compute-node/system-profile');
      const result = await listProjectsFromComputeNode(p.nodeId, ctx.signal);
      if (ctx.isCurrent()) (await import('../stores/project-cleanup-store')).ingestCleanupSummary(result.cleanup);
      return result;
    },
  }),
  [LazyAsset.ProjectResources]: defineAsset({
    staleTime: 60_000,
    load: async (p: { nodeId: string; encodedName: string; includeSessions: boolean }, ctx: LoadContext) =>
      (await import('../entities/compute-node/system-profile')).scanProjectFromComputeNode(
        p.nodeId, p.encodedName, 100, p.includeSessions, ctx.signal),
  }),
  [LazyAsset.Skills]: defineAsset({
    load: async (p: { nodeId: string }) => (await import('../entities/compute-node/system-profile')).fetchAllSkillsFromComputeNode(p.nodeId),
  }),
  [LazyAsset.FavoriteSummaries]: defineAsset({
    staleTime: 15_000,
    key: (p: { refs: FavoriteRef[] }) => p.refs.map(r => `${r.type}:${r.id}`).sort(),
    load: async (p: { refs: FavoriteRef[] }): Promise<FavoriteSummaries> => p.refs.length ?
      (await apiClient.post<FavoriteSummaries>('/api/v1/favorites/summary', p)) ?? { summaries: [] } : { summaries: [] },
  }),
  [LazyAsset.Activities]: defineAsset({
    staleTime: Infinity,
    load: async (_: undefined) => isHubOnly() ? [] : (await import('../activity')).listActivities(null, true),
  }),
  [LazyAsset.IndexActivity]: defineAsset({
    staleTime: Infinity,
    load: async (_: undefined, ctx: LoadContext) => (await import('../services/system-tools-service')).systemTools.fetchActivityStatus(ctx.isCurrent),
  }),
  [LazyAsset.Connections]: defineAsset({
    key: (p: (NodeParams & { projectId?: string }) | undefined) => [p?.nodeTypeId ?? localNode, p?.projectId ?? ''],
    staleTime: 10_000,
    load: async (p: (NodeParams & { projectId?: string }) | undefined) => {
      const { ConnectionsService } = await import('../services/connections-service');
      return new ConnectionsService(p?.nodeTypeId ?? localNode).fetchList(p?.projectId);
    },
  }),
  [LazyAsset.LlmFunding]: defineAsset({
    staleTime: 10_000,
    key: (p: NodeParams | undefined) => p?.nodeTypeId ?? localNode,
    load: async (p: NodeParams | undefined) => {
      const { LlmSourcesService } = await import('../services/llm-sources-service');
      return new LlmSourcesService(p?.nodeTypeId ?? localNode).fetchStatus();
    },
  }),
  [LazyAsset.GitRepos]: defineAsset({
    load: async (p: { provider: GitProvider }) => (await import('../services/git-providers')).fetchRepos(p.provider),
  }),
  [LazyAsset.GitBranches]: defineAsset({
    load: async (p: { git_origin: GitOrigin }) => (await import('../services/git-providers')).fetchBranches(p),
  }),
  [LazyAsset.GitInvitations]: defineAsset({
    load: async (p: { provider: GitProvider }) => (await import('../services/git-providers')).fetchInvitations(p.provider),
  }),
};

export type AssetParams<A extends LazyAsset> = Parameters<(typeof assetDefinitions)[A]['load']>[0];
export type AssetData<A extends LazyAsset> = Awaited<ReturnType<(typeof assetDefinitions)[A]['load']>>;
