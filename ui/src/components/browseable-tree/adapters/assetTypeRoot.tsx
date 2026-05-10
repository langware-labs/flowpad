import React from 'react';
import { FileText, Folder, Plus, RefreshCw, User as UserIcon } from 'lucide-react';
import { lucideByName } from '@src/lib/lucide-by-name';
import apiClient from '@sdk/client';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';
import type { AssetTypeInfo } from '@src/hooks/use-asset-types';
import type { SearchResult } from '@src/hooks/use-asset-search';
import { DEFAULT_ASSET_FILTER, applyFilterToParams } from '@src/components/assets/assetFilter';
import type { AssetFilter } from '@src/components/assets/assetFilter';
import type { Browseable, BrowseableRoot, ToolbarAction } from '@src/components/browseable-tree/types';

export interface AssetTypeRootDeps {
  /** Per-row refresh callback, e.g. systemTools.indexType from useSystemTools.
   *  Receives the active filter so per-type scans can scope to the same. */
  indexType: (typeName: string, filter?: AssetFilter) => Promise<{ indexed?: number } | void>;
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

/** A discovery source — "User" or one project — surfaced as a one-level
 *  grouping under each non-markdown type root. */
export interface RecordGroup {
  /** Stable key for React. */
  key: string;
  /** Display label ("User" or the project name). */
  label: string;
  /** Records that fell into this bucket. */
  records: SearchResult[];
}

/**
 * Bucket records by discovery source: scope='user' → "User"; scope='project'
 * → one bucket per `project_encoded_name` (fallback `project_encoded`).
 * Records with neither scope are dropped — they wouldn't pass the backend
 * filter anyway. Order is stable: User first, then projects alpha.
 */
export function groupRecords(results: SearchResult[]): RecordGroup[] {
  const userBucket: SearchResult[] = [];
  const projectBuckets = new Map<string, { label: string; records: SearchResult[] }>();
  for (const r of results) {
    if (r.scope === 'user') {
      userBucket.push(r);
      continue;
    }
    if (r.scope === 'project') {
      const label = r.project_encoded_name || r.project_encoded || '(unknown project)';
      const key = `project:${r.project_encoded || label}`;
      let bucket = projectBuckets.get(key);
      if (!bucket) {
        bucket = { label, records: [] };
        projectBuckets.set(key, bucket);
      }
      bucket.records.push(r);
    }
  }
  const out: RecordGroup[] = [];
  if (userBucket.length > 0) {
    out.push({ key: 'user', label: 'User', records: userBucket });
  }
  const sortedProjects = [...projectBuckets.entries()].sort((a, b) =>
    a[1].label.localeCompare(b[1].label),
  );
  for (const [key, { label, records }] of sortedProjects) {
    out.push({ key, label, records });
  }
  return out;
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
  if (!pointer) return { mode: null, typeName: null, vfsPath: null, wikiName: null };
  if (pointer.startsWith('editor/')) {
    const rest = pointer.slice('editor/'.length);
    const slash = rest.indexOf('/');
    if (slash < 0) return { mode: 'editor', typeName: rest || null, vfsPath: null, wikiName: null };
    return {
      mode: 'editor',
      typeName: rest.slice(0, slash) || null,
      vfsPath: rest.slice(slash + 1) || null,
      wikiName: null,
    };
  }
  if (pointer.startsWith('list/')) {
    return { mode: 'list', typeName: pointer.slice('list/'.length) || null, vfsPath: null, wikiName: null };
  }
  if (pointer.startsWith('wiki/')) {
    const raw = pointer.slice('wiki/'.length);
    let name = raw;
    try { name = decodeURIComponent(raw); } catch { /* keep raw */ }
    return { mode: 'wiki', typeName: 'markdown', vfsPath: null, wikiName: name || null };
  }
  return { mode: null, typeName: null, vfsPath: null, wikiName: null };
}

function resolveAssetIcon(iconName: string | null): React.ReactNode {
  const Icon = lucideByName(iconName);
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
  const label = result.name || basename(result.asset_ref) || '(untitled)';
  // Projects open in their collaboration space rather than the asset editor.
  const pointer = typeName === 'project'
    ? DockPointer.forProject(result.record_id)
    : DockPointer.forAssetEditor(typeName, result.asset_ref);
  return {
    id: `asset:${typeName}:${result.asset_ref}`,
    kind: 'asset',
    label,
    icon: <FileText className="h-3.5 w-3.5 flex-shrink-0" />,
    hasChildren: false,
    pointer,
  };
}

function basename(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx >= 0 ? p.slice(idx + 1) : p;
}

/**
 * Count badge rendered to the right of a type row. Uses the same /search
 * endpoint with limit=1 so we get `total` without full results. The active
 * filter is serialized so the badge tracks the scope/project picker.
 */
function AssetTypeCountBadge({
  typeName,
  filter,
  refreshKey,
}: {
  typeName: string;
  filter: AssetFilter;
  refreshKey?: number;
}) {
  const [total, setTotal] = React.useState<number | null>(null);
  // Stable key so the effect re-runs only when the filter shape changes.
  const filterKey = React.useMemo(() => {
    const p = new URLSearchParams();
    applyFilterToParams(p, filter);
    return p.toString();
  }, [filter]);
  React.useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    params.set('record_type', typeName);
    params.set('offset', '0');
    params.set('limit', '1');
    applyFilterToParams(params, filter);
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
    // filterKey captures the relevant filter shape; filter is referenced inside.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeName, filterKey, refreshKey]);
  if (total === null || total === 0) return null;
  return (
    <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
      {total > 999 ? '999+' : total}
    </span>
  );
}

/** Static badge showing a precomputed count (for group rows). */
function StaticCountBadge({ count }: { count: number }) {
  if (!count) return null;
  return (
    <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
      {count > 999 ? '999+' : count}
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
        await deps.indexType(type.type_name, deps.filter);
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
    const groups = groupRecords(results);
    // 0 or 1 source → render records flat (no redundant wrapper).
    if (groups.length <= 1) {
      return results.map((r) => assetChild(type.type_name, r));
    }
    // ≥2 sources → one level of grouping.
    return groups.map((g) => ({
      id: `asset-group:${type.type_name}:${g.key}`,
      kind: 'group',
      label: g.label,
      icon:
        g.key === 'user' ? (
          <UserIcon className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
        ) : (
          <Folder className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
        ),
      badge: <StaticCountBadge count={g.records.length} />,
      hasChildren: true,
      pointer: null,
      listChildren: async () => g.records.map((r) => assetChild(type.type_name, r)),
    } satisfies Browseable));
  };

  const root: BrowseableRoot = {
    id: `asset-type:${type.type_name}`,
    kind: 'root',
    label: type.label,
    icon: resolveAssetIcon(type.icon),
    badge: <AssetTypeCountBadge typeName={type.type_name} filter={filter} />,
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
