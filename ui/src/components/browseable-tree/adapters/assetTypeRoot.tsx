import React from 'react';
import { Plus, RefreshCw, Trash2 } from 'lucide-react';
import { lucideByName } from '@src/lib/lucide-by-name';
import apiClient from '@sdk/client';
import { DockPointer } from '@src/navigation/DockPointer';
import { AssetDocPointer } from '@src/navigation/AssetDocPointer';
import { AssetMode, AssetRoutingMethod } from '@src/navigation/asset-doc-types';
import { VFSPath } from '@sdk';
import { ViewType } from '@src/types/ViewType';
import type { AssetTypeInfo } from '@src/hooks/use-asset-types';
import type { SearchResult } from '@src/hooks/use-asset-search';
import { DEFAULT_ASSET_FILTER, applyFilterToParams } from '@src/components/assets/assetFilter';
import { scopeFilterKey } from '@src/lib/scope-filter';
import type { AssetFilter } from '@src/components/assets/assetFilter';
import type { Browseable, BrowseableRoot, ToolbarAction } from '@src/components/browseable-tree/types';
import { showDeleteAssetModal } from '@src/components/assets/delete-asset-modal';
import { refreshNode } from '@src/components/browseable-tree/refresh-store';
import { skillCreateActions, skillFolderListChildren } from './skillFolder';
import { config } from '@sdk';

export interface AssetTypeRootDeps {
  /** Per-row refresh callback, e.g. systemTools.indexType from useSystemTools.
   *  Receives the active filter so per-type scans can scope to the same. */
  indexType: (
    typeName: string,
    scope?: { user: boolean; projects: string[] },
    options?: { force?: boolean; orphanAction?: 'index' | 'ignore' | 'delete' },
  ) => Promise<{ indexed?: number } | void>;
  /** Called when the "New" toolbar button is clicked for a creatable type. */
  onNew?: (typeName: string) => void;
  /** Types that can be created via "New"; others render without the plus button. */
  creatableTypes?: Set<string>;
  /** Active filter (scope + query etc.), forwarded to the search API so the
   *  sidebar children honor the same filter as the list view. */
  filter?: AssetFilter;
  /** Max number of children to fetch per type. Default 200. */
  childrenPageSize?: number;
  /** Called after a successful scan so the parent can refresh counts. */
  onScanComplete?: (typeName: string) => void;
  /** Called after a successful asset delete so the parent can refresh counts + tree. */
  onDeleteComplete?: (typeName: string) => void;
}

interface AssetPointerParts {
  mode: 'editor' | 'list' | 'wiki' | null;
  typeName: string | null;
  vfsPath: string | null;
  /** Name target when mode === 'wiki'. */
  wikiName: string | null;
}

/**
 * Parse an asset pointer (copied from AssetsPage; kept in sync with the
 * DockPointer factories). Pointer format:
 *   `list/<typeName>`
 *   `editor/<typeName>/<vfsPath>`
 *   `wiki/<encoded name>`
 */
export function parseAssetPointer(pointer: string | null | undefined): AssetPointerParts {
  const empty: AssetPointerParts = { mode: null, typeName: null, vfsPath: null, wikiName: null };
  if (!pointer) return empty;
  // `list/` isn't an AssetDocPointer mode — handle it directly.
  if (pointer.startsWith('list/')) {
    return { ...empty, mode: 'list', typeName: pointer.slice('list/'.length) || null };
  }
  try {
    const ptr = AssetDocPointer.parse(pointer);
    if (ptr.mode === AssetMode.WIKI) {
      return { ...empty, mode: 'wiki', typeName: 'markdown', wikiName: ptr.wikiName || null };
    }
    // editor mode: typeName = the editor; vfsPath only exists for the vfs method.
    const vfsPath =
      ptr.method === AssetRoutingMethod.VFS ? VFSPath.parse(ptr.value).entitySubPath || null : null;
    return { ...empty, mode: 'editor', typeName: ptr.editor || null, vfsPath };
  } catch {
    return empty;
  }
}

function resolveAssetIcon(iconName: string | null, className = 'h-4 w-4 flex-shrink-0'): React.ReactNode {
  const Icon = lucideByName(iconName);
  return <Icon className={className} />;
}

/**
 * Fetch assets of a given type via the existing `/search` endpoint. This
 * mirrors the URL construction inside useAssetSearch but without the
 * debounce/pagination machinery (we want a single flat list for the tree).
 */
async function fetchAssetsOfType(
  typeName: string,
  filter: AssetFilter,
  limit: number,
): Promise<SearchResult[]> {
  const urlParams = new URLSearchParams();
  urlParams.set('record_type', typeName);
  urlParams.set('offset', '0');
  urlParams.set('limit', String(limit));
  if (filter.query.length >= 2) urlParams.set('q', filter.query);
  applyFilterToParams(urlParams, filter);
  try {
    const data = (await apiClient.get(`/search?${urlParams.toString()}`)) as
      | { results?: SearchResult[] }
      | null;
    return data?.results ?? [];
  } catch {
    return [];
  }
}

/**
 * Canonical tree-node id for an asset. The path is normalized to the same
 * leading-slash-stripped form `DockPointer.forAssetEditor` uses for the
 * pointer, so the id built from a search result's `asset_ref` (`/Users/…`)
 * matches the id built from a URL pointer's `vfsPath` (`Users/…`). Without
 * this, the deep-link freshness check in `useBrowseableTree` never finds the
 * leaf among its parent's children and force-refreshes in a loop.
 */
function assetNodeId(typeName: string, path: string): string {
  return `asset:${typeName}:${path.replace(/^\/+/, '')}`;
}

/**
 * Build a child Browseable from a SearchResult.
 */
function assetChild(typeName: string, iconName: string | null, result: SearchResult, folderBacked: boolean, onAfterDelete?: () => void): Browseable {
  const label = result.name || basename(result.asset_ref) || '(untitled)';
  // Projects open in their collaboration space rather than the asset editor.
  const pointer = typeName === 'project'
    ? DockPointer.forProject(result.record_id)
    : DockPointer.forAssetEditor(typeName, result.asset_ref);
  const toolbar: ToolbarAction[] = [];
  // Projects open in their collaboration space and aren't deleted from the
  // asset sidebar; everything else (markdown, agent, skill, workflow, plan,
  // claude_md, …) routes through the same /graph/<type>/<id> DELETE endpoint.
  if (typeName !== 'project') {
    toolbar.push({
      id: `delete:${typeName}:${result.record_id}`,
      icon: <Trash2 />,
      label: `Delete ${label}`,
      run: () => {
        showDeleteAssetModal({
          name: label,
          onConfirm: async () => {
            await apiClient.delete(`${config.API_PREFIXES.graph}/${typeName}/${result.record_id}`);
          },
          onAfterDelete,
        });
      },
      showBusyIndicator: false,
    });
  }
  const node: Browseable = {
    id: assetNodeId(typeName, result.asset_ref),
    kind: 'asset',
    label,
    icon: resolveAssetIcon(iconName, 'h-3.5 w-3.5 flex-shrink-0'),
    hasChildren: false,
    pointer,
    toolbar: toolbar.length > 0 ? toolbar : undefined,
  };

  // Folder-backed types (asset_ref is a bare folder, e.g. skill) expand the row
  // to browse/create/delete their files inline — one unified tree, no second
  // panel. The flag comes from TypeInfo.folder_backed (derived from the folder
  // layout), so any such type gets this without a per-type string branch.
  if (folderBacked && result.asset_ref) {
    return {
      ...node,
      hasChildren: 'unknown',
      toolbar: [...skillCreateActions(result.asset_ref, node.id), ...toolbar],
      listChildren: skillFolderListChildren(result.asset_ref, node.id),
    };
  }

  return node;
}

function basename(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx >= 0 ? p.slice(idx + 1) : p;
}

/**
 * Per-type entity counts, keyed by `type_name`, supplied by the asset page from
 * the single `index-status` response it already fetches — so the sidebar renders
 * N type badges from one request instead of one `/search?limit=1` probe per row
 * (the N+1 that dominated the list page's request count). `null` (no provider)
 * simply renders no badges.
 */
export const AssetTypeCountsContext = React.createContext<Map<string, number> | null>(null);

/**
 * Count badge rendered to the right of a type row — a pure render of the count
 * from `AssetTypeCountsContext`. Renders nothing when the count is 0 or absent.
 */
export function AssetTypeCountBadge({ typeName }: { typeName: string }) {
  const total = React.useContext(AssetTypeCountsContext)?.get(typeName) ?? 0;
  if (total === 0) return null;
  return (
    <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
      {total > 999 ? '999+' : total}
    </span>
  );
}

/**
 * Build toolbar actions for a type row: "Scan" (reindex) and, for creatable
 * types, "New". All side effects — never navigation.
 */
function buildRootToolbar(type: AssetTypeInfo, deps: AssetTypeRootDeps): ToolbarAction[] {
  const actions: ToolbarAction[] = [
    {
      id: `scan:${type.type_name}`,
      icon: <RefreshCw />,
      label: 'Scan for changes',
      run: async () => {
        await deps.indexType(type.type_name, deps.filter?.scope);
        deps.onScanComplete?.(type.type_name);
      },
    },
  ];
  const isCreatable = !deps.creatableTypes || deps.creatableTypes.has(type.type_name);
  if (deps.onNew && isCreatable) {
    actions.push({
      id: `new:${type.type_name}`,
      icon: <Plus />,
      label: `New ${type.label}`,
      run: () => deps.onNew?.(type.type_name),
      showBusyIndicator: false,
    });
  }
  return actions;
}

/**
 * Build a BrowseableRoot for a single asset type. The root lazy-loads its
 * children on expand and owns any asset pointer whose typeName matches.
 */
export function assetTypeRoot(type: AssetTypeInfo, deps: AssetTypeRootDeps): BrowseableRoot {
  const filter = deps.filter ?? DEFAULT_ASSET_FILTER;
  const limit = deps.childrenPageSize ?? 200;

  // Filter signature in the id forces the BrowseableTree to refetch
  // children when the user toggles scope/picker (the children are cached
  // by node id; without this they'd stay frozen at the previous filter).
  const filterSig = scopeFilterKey(filter.scope);
  const rootId = `asset-type:${type.type_name}:${filterSig}`;

  // After delete: ask the tree to invalidate this root's children. The deleted
  // row drops out without resetting the user's expansion state. The optional
  // `onDeleteComplete` deps callback runs too so callers can refresh
  // ancillary state (e.g. count badges).
  const onAfterDelete = () => {
    refreshNode(rootId);
    deps.onDeleteComplete?.(type.type_name);
  };
  const listChildren = async (): Promise<Browseable[]> => {
    const results = await fetchAssetsOfType(type.type_name, filter, limit);
    return results.map((r) => assetChild(type.type_name, type.icon, r, !!type.folder_backed, onAfterDelete));
  };

  const root: BrowseableRoot = {
    id: rootId,
    kind: 'root',
    label: type.label,
    icon: resolveAssetIcon(type.icon),
    badge: <AssetTypeCountBadge typeName={type.type_name} />,
    hasChildren: true,
    pointer: DockPointer.forAssetList(type.type_name),
    toolbar: buildRootToolbar(type, deps),
    listChildren,
    ownsPointer: (p) => {
      if (p.viewType !== ViewType.ASSETS) return false;
      const parsed = parseAssetPointer(p.pointer);
      return parsed.typeName === type.type_name;
    },
    pathFor: async (p) => {
      const parsed = parseAssetPointer(p.pointer);
      if (parsed.mode === 'list') {
        // The type's own list view (`list/<type>`) is the active pointer: the
        // right panel already fetches and shows this type's entities (paginated).
        // Returning an empty chain skips auto-expanding this root, which would
        // otherwise bulk-fetch up to `childrenPageSize` (200) of the SAME
        // entities into the sidebar — a duplicate `/search` for data already on
        // screen. The root still highlights via `ownsPointer`/active-pointer
        // match, and the user can expand it manually to load children on demand.
        return [];
      }
      if (parsed.mode === null) {
        return [root];
      }
      if (!parsed.vfsPath) return [root];
      const leaf: Browseable = {
        id: assetNodeId(type.type_name, parsed.vfsPath),
        kind: 'asset',
        label: basename(parsed.vfsPath),
        icon: resolveAssetIcon(type.icon, 'h-3.5 w-3.5 flex-shrink-0'),
        hasChildren: false,
        pointer: DockPointer.forAssetEditor(type.type_name, parsed.vfsPath),
      };
      return [root, leaf];
    },
  };
  return root;
}
