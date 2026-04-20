import React from 'react';
import * as lucideIcons from 'lucide-react';
import { File, FileText, Plus, RefreshCw } from 'lucide-react';
import apiClient from '@sdk/client';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';
import type { AssetTypeInfo } from '@src/hooks/use-asset-types';
import type { SearchResult } from '@src/hooks/use-asset-search';
import { DEFAULT_ASSET_FILTER, applyFilterToParams } from '@src/components/assets/assetFilter';
import type { AssetFilter } from '@src/components/assets/assetFilter';
import type { Browseable, BrowseableRoot, ToolbarAction } from '@src/components/browseable-tree/types';

export interface AssetTypeRootDeps {
  /** Per-row refresh callback, e.g. systemTools.indexType from useSystemTools. */
  indexType: (typeName: string) => Promise<{ indexed?: number } | void>;
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
}

interface AssetPointerParts {
  mode: 'editor' | 'list' | null;
  typeName: string | null;
  vfsPath: string | null;
}

/**
 * Parse an asset pointer (copied from AssetsPage; kept in sync with the
 * DockPointer factories). Pointer format:
 *   `list/<typeName>`
 *   `editor/<typeName>/<vfsPath>`
 */
export function parseAssetPointer(pointer: string | null | undefined): AssetPointerParts {
  if (!pointer) return { mode: null, typeName: null, vfsPath: null };
  if (pointer.startsWith('editor/')) {
    const rest = pointer.slice('editor/'.length);
    const slash = rest.indexOf('/');
    if (slash < 0) return { mode: 'editor', typeName: rest || null, vfsPath: null };
    return {
      mode: 'editor',
      typeName: rest.slice(0, slash) || null,
      vfsPath: rest.slice(slash + 1) || null,
    };
  }
  if (pointer.startsWith('list/')) {
    return { mode: 'list', typeName: pointer.slice('list/'.length) || null, vfsPath: null };
  }
  return { mode: null, typeName: null, vfsPath: null };
}

/**
 * Resolve a Lucide icon by name, falling back to a generic file icon.
 */
function resolveAssetIcon(iconName: string | null): React.ReactNode {
  const key = iconName as keyof typeof lucideIcons | null;
  const Icon = (key && key in lucideIcons
    ? (lucideIcons[key] as React.FC<{ className?: string }>)
    : File) as React.FC<{ className?: string }>;
  return <Icon className="h-4 w-4 flex-shrink-0" />;
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
 * Build a child Browseable from a SearchResult.
 */
function assetChild(typeName: string, result: SearchResult): Browseable {
  const label = result.name || basename(result.source_path) || '(untitled)';
  return {
    id: `asset:${typeName}:${result.source_path}`,
    kind: 'asset',
    label,
    icon: <FileText className="h-3.5 w-3.5 flex-shrink-0" />,
    hasChildren: false,
    pointer: DockPointer.forAssetEditor(typeName, result.source_path),
  };
}

function basename(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx >= 0 ? p.slice(idx + 1) : p;
}

/**
 * Count badge rendered to the right of a type row. Uses the same /search
 * endpoint with limit=1 so we get `total` without full results.
 */
function AssetTypeCountBadge({ typeName, refreshKey }: { typeName: string; refreshKey?: number }) {
  const [total, setTotal] = React.useState<number | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    params.set('record_type', typeName);
    params.set('offset', '0');
    params.set('limit', '1');
    apiClient
      .get(`/search?${params.toString()}`)
      .then((d: unknown) => {
        if (cancelled) return;
        const data = d as { total?: number } | null;
        setTotal(data?.total ?? 0);
      })
      .catch(() => {
        if (!cancelled) setTotal(0);
      });
    return () => {
      cancelled = true;
    };
  }, [typeName, refreshKey]);
  if (total === null || total === 0) return null;
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
        await deps.indexType(type.type_name);
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

  const listChildren = async (): Promise<Browseable[]> => {
    const results = await fetchAssetsOfType(type.type_name, filter, limit);
    return results.map((r) => assetChild(type.type_name, r));
  };

  const root: BrowseableRoot = {
    id: `asset-type:${type.type_name}`,
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
      if (parsed.mode === 'list' || parsed.mode === null) {
        return [root];
      }
      // editor mode: synthesize the leaf directly from the pointer. No fetch
      // needed — the pointer already carries everything the leaf shows.
      if (!parsed.vfsPath) return [root];
      const leaf: Browseable = {
        id: `asset:${type.type_name}:${parsed.vfsPath}`,
        kind: 'asset',
        label: basename(parsed.vfsPath),
        icon: <FileText className="h-3.5 w-3.5 flex-shrink-0" />,
        hasChildren: false,
        pointer: DockPointer.forAssetEditor(type.type_name, parsed.vfsPath),
      };
      return [root, leaf];
    },
  };
  return root;
}
