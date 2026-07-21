import React from 'react';
import { Plus, RefreshCw, Trash2 } from 'lucide-react';
import { lucideByName } from '@src/lib/lucide-by-name';
import apiClient from '@sdk/client';
import { DockPointer } from '@src/navigation/DockPointer';
import { resultTypeId } from '@src/navigation/record-type-nav';
import { AssetDocPointer } from '@src/navigation/AssetDocPointer';
import { AssetMode, AssetRoutingMethod } from '@src/navigation/asset-doc-types';
import { VFSPath, isTypeId, TypeId } from '@sdk';
import { ViewType } from '@src/types/ViewType';
import type { AssetTypeInfo } from '@src/hooks/use-asset-types';
import type { SearchResult } from '@src/hooks/use-asset-search';
import { DEFAULT_ASSET_FILTER, applyFilterToParams } from '@src/components/assets/assetFilter';
import { type ScopeFilter } from '@src/lib/scope-filter';
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
    scope?: ScopeFilter,
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
    const vfsPath = ptr.method === AssetRoutingMethod.VFS ? VFSPath.parse(ptr.value).entitySubPath || null : null;
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
async function fetchAssetsOfType(typeName: string, filter: AssetFilter, limit: number): Promise<SearchResult[]> {
  const urlParams = new URLSearchParams();
  urlParams.set('record_type', typeName);
  urlParams.set('offset', '0');
  urlParams.set('limit', String(limit));
  if (filter.query.length >= 2) urlParams.set('q', filter.query);
  applyFilterToParams(urlParams, filter);
  try {
    const data = (await apiClient.get(`/search?${urlParams.toString()}`)) as { results?: SearchResult[] } | null;
    // Member tasks (group-task children) are kept here — the tree nests them
    // under their parent (see buildTaskTree) rather than dropping them.
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
function assetChild(
  typeName: string,
  iconName: string | null,
  result: SearchResult,
  folderBacked: boolean,
  rootId: string,
  onAfterDelete?: () => void,
): Browseable {
  const label = result.name || basename(result.asset_ref) || '(untitled)';
  // Projects open in their collaboration space rather than the asset editor.
  const pointer =
    typeName === 'project'
      ? DockPointer.forProject(result.record_id)
      : DockPointer.forAssetEditor(typeName, result.asset_ref);
  // Projects open in their collaboration space and aren't deleted from the
  // asset sidebar; everything else (markdown, agent, skill, workflow, plan,
  // claude_md, …) routes through the same /graph/<type>/<id> DELETE endpoint.
  // The raw delete is defined once and reused by both the hover toolbar (wrapped
  // in a confirm) and the multi-select `bulkDelete`.
  const deletable = typeName !== 'project';
  const deleteRun = async () => {
    await apiClient.delete(`${config.API_PREFIXES.graph}/${typeName}/${result.record_id}`);
  };
  const toolbar: ToolbarAction[] = [];
  if (deletable) {
    toolbar.push({
      id: `delete:${typeName}:${result.record_id}`,
      icon: <Trash2 />,
      label: `Delete ${label}`,
      run: () => showDeleteAssetModal({ name: label, onConfirm: deleteRun, onAfterDelete }),
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
    // Stable typeid (`<type>-<uuid>`) so a typeid-form active pointer selects this
    // row even though `pointer` is the vfs form. `resultTypeId` handles bare-uuid
    // vs full-typeid `record_id`. Doubles as the multi-select membership key.
    selectionKey: resultTypeId(result)?.toString(),
    // Multi-select: entity rows participate; a bulk delete refreshes the owning
    // type root so removed rows drop out.
    selectable: deletable,
    selectionType: typeName,
    bulkDelete: deletable ? { run: deleteRun, refreshId: rootId } : undefined,
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

/** Bare entity uuid for a raw id string that may be a `<type>-<uuid>` typeid or
 *  already a bare uuid. A task's `parent_id` is the parent's entity id in either
 *  form, so both sides of the parent↔child match must be normalized. */
function bareEntityId(raw: string | null | undefined): string {
  const s = (raw ?? '').trim();
  if (!s) return '';
  try {
    if (isTypeId(s)) return new TypeId(s).id;
  } catch {
    /* not a typeid — use as-is */
  }
  return s;
}

/**
 * Build the task rows for the asset tree with member (child) tasks nested under
 * their parent. `parent_id` ("" = top-level, else the parent task's entity id)
 * defines the relationship. Children whose parent is present in this result page
 * render indented under it — children first, then the parent's own folder files
 * (task.md / spec.md …). A child whose parent is absent (top-level, or an orphan
 * the page's limit cut off) renders at the root so nothing disappears.
 */
function buildTaskTree(
  type: AssetTypeInfo,
  results: SearchResult[],
  rootId: string,
  onAfterDelete: () => void,
): Browseable[] {
  const byId = new Map<string, SearchResult>();
  for (const r of results) {
    const id = resultTypeId(r)?.id;
    if (id) byId.set(id, r);
  }
  const childrenByParent = new Map<string, SearchResult[]>();
  const topLevel: SearchResult[] = [];
  for (const r of results) {
    const pid = bareEntityId(r.parent_id);
    if (pid && byId.has(pid)) {
      const arr = childrenByParent.get(pid) ?? [];
      arr.push(r);
      childrenByParent.set(pid, arr);
    } else {
      topLevel.push(r);
    }
  }

  // A tree node's identity is its asset path, so a duplicate DB record for one
  // on-disk task must collapse to a single row (shared across the whole tree).
  const seen = new Set<string>();
  const buildNode = (r: SearchResult, ancestry: Set<string>): Browseable | null => {
    const node = assetChild(type.type_name, type.icon, r, !!type.folder_backed, rootId, onAfterDelete);
    if (seen.has(node.id)) return null;
    seen.add(node.id);
    const selfBare = resultTypeId(r)?.id ?? '';
    // Guard against a `parent_id` cycle: don't recurse into an ancestor.
    const childResults = selfBare && !ancestry.has(selfBare) ? (childrenByParent.get(selfBare) ?? []) : [];
    if (childResults.length === 0) return node;
    const nextAncestry = new Set(ancestry);
    if (selfBare) nextAncestry.add(selfBare);
    const childNodes = childResults.map((cr) => buildNode(cr, nextAncestry)).filter((n): n is Browseable => n !== null);
    // Combine member (child) task rows with the parent's own folder-backed
    // listChildren (task.md / spec.md …) — children first, folder files after.
    const folderList = node.listChildren;
    return {
      ...node,
      hasChildren: true,
      listChildren: async (opts) => {
        const folderRows = folderList ? await folderList(opts) : [];
        return [...childNodes, ...folderRows];
      },
    };
  };

  return topLevel.map((r) => buildNode(r, new Set<string>())).filter((n): n is Browseable => n !== null);
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
        // Reindex this type; the resulting data_ops flow back to the tree via
        // the useAssetTreeRefresh subscription, which re-fetches this root.
        await deps.indexType(type.type_name, deps.filter?.scope);
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

  // STABLE id — deliberately independent of the filter scope. The scope key
  // oscillates several times while a file opens (URL-scope re-seed, the
  // open-asset bucket collapsing, a stats refetch); baking it into the id used
  // to remount this root on every wobble, which dropped its children and
  // re-flashed "Loading…" — the sidebar "blink". Scope changes now refetch via
  // an invalidate that keeps existing rows on screen (no flash) — see the
  // scope-change effect in useAssetTreeRefresh.
  const rootId = `asset-type:${type.type_name}`;

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
    // Tasks nest: a group/parent task's member (child) tasks render indented
    // under it (children first, then the parent's folder files). See buildTaskTree.
    if (type.type_name === 'task') {
      return buildTaskTree(type, results, rootId, onAfterDelete);
    }
    // A tree node's identity is its asset path (`asset:<type>:<path>`), so the
    // same file surfaced by more than one search result (e.g. discovered under
    // multiple scopes, or duplicate DB records for one on-disk asset) must
    // collapse to a single row — otherwise two children share a React key.
    const seen = new Set<string>();
    const children: Browseable[] = [];
    for (const r of results) {
      const child = assetChild(type.type_name, type.icon, r, !!type.folder_backed, rootId, onAfterDelete);
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      children.push(child);
    }
    return children;
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
    pathFor: (p) => {
      const parsed = parseAssetPointer(p.pointer);
      if (parsed.mode === 'list') {
        // The type's own list view (`list/<type>`) is the active pointer: the
        // right panel already fetches and shows this type's entities (paginated).
        // Returning an empty chain skips auto-expanding this root, which would
        // otherwise bulk-fetch up to `childrenPageSize` (200) of the SAME
        // entities into the sidebar — a duplicate `/search` for data already on
        // screen. The root still highlights via `ownsPointer`/active-pointer
        // match, and the user can expand it manually to load children on demand.
        return Promise.resolve([]);
      }
      if (parsed.mode === null) {
        return Promise.resolve([root]);
      }
      if (!parsed.vfsPath) return Promise.resolve([root]);
      const leaf: Browseable = {
        id: assetNodeId(type.type_name, parsed.vfsPath),
        kind: 'asset',
        label: basename(parsed.vfsPath),
        icon: resolveAssetIcon(type.icon, 'h-3.5 w-3.5 flex-shrink-0'),
        hasChildren: false,
        pointer: DockPointer.forAssetEditor(type.type_name, parsed.vfsPath),
      };
      return Promise.resolve([root, leaf]);
    },
  };
  return root;
}
