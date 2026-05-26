import React from 'react';
import { FileText, Folder, FolderPlus, Library, Plus, RefreshCw, User as UserIcon } from 'lucide-react';
import { lucideByName } from '@src/lib/lucide-by-name';
import apiClient from '@sdk/client';
import { fsStore, TypeId } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';
import type { AssetTypeInfo, AssetTypeVault } from '@src/hooks/use-asset-types';
import type {
  Browseable,
  BrowseableDragData,
  BrowseableRoot,
  ToolbarAction,
} from '@src/components/browseable-tree/types';
import { parseAssetPointer } from './assetTypeRoot';
import {
  DEFAULT_ASSET_FILTER,
  applyFilterToParams,
} from '@src/components/assets/assetFilter';
import type { AssetFilter } from '@src/components/assets/assetFilter';

export interface MarkdownFolderRootDeps {
  /** Reindex callback for the "Scan" toolbar button. Forwards the active
   *  filter so per-type scans honor the same scope. */
  indexType: (
    typeName: string,
    scope?: { user: boolean; projects: string[] },
    options?: { force?: boolean; orphanAction?: 'index' | 'ignore' | 'delete' },
  ) => Promise<{ indexed?: number } | void>;
  /** Called when the root-level "New" toolbar is clicked (falls back to the
   *  legacy flow which creates under .claude/docs). */
  onNew?: (typeName: string) => void;
  /** Called when a vault/folder wants a new child folder. */
  onCreateFolder?: (target: MarkdownFolderTarget) => void;
  /** Called when a markdown file/folder is dropped onto a folder target. */
  onMoveItem?: (item: MarkdownDragItem, target: MarkdownFolderTarget) => Promise<void> | void;
  /** Called after a successful scan. */
  onScanComplete?: (typeName: string) => void;
  /** Max entries to fetch per folder from the filesystem. Default 500. */
  folderPageSize?: number;
  /** Active filter — used by the count badge so it tracks scope/project. */
  filter?: AssetFilter;
}

export interface MarkdownFolderTarget {
  typeName: string;
  typeid: string;
  relPath: string;
  absPath: string;
  label: string;
}

export interface MarkdownDragItem extends BrowseableDragData {
  kind: 'markdown-file' | 'markdown-folder';
  typeName: string;
  typeid: string;
  relPath: string;
  absPath: string;
  isDir: boolean;
}

export function markdownFolderNodeId(typeid: string, absPath: string): string {
  return `md-folder:${typeid}:${absPath || '/'}`;
}

function normalizeRelPath(path: string): string {
  return path.replace(/^\/+/, '').replace(/\/+$/, '');
}

function parentRelPath(path: string): string {
  const normalized = normalizeRelPath(path);
  const idx = normalized.lastIndexOf('/');
  return idx <= 0 ? '' : normalized.slice(0, idx);
}

function isMarkdownDragItem(data: BrowseableDragData): data is MarkdownDragItem {
  return (
    (data.kind === 'markdown-file' || data.kind === 'markdown-folder') &&
    typeof data.typeName === 'string' &&
    typeof data.typeid === 'string' &&
    typeof data.relPath === 'string' &&
    typeof data.absPath === 'string'
  );
}

function canDropMarkdownItem(target: MarkdownFolderTarget, data: BrowseableDragData): boolean {
  if (!isMarkdownDragItem(data)) return false;
  if (data.typeName !== target.typeName || data.typeid !== target.typeid) return false;
  const sourceRel = normalizeRelPath(data.relPath);
  const targetRel = normalizeRelPath(target.relPath);
  if (!sourceRel) return false;
  if (parentRelPath(sourceRel) === targetRel) return false;
  if (data.kind === 'markdown-folder') {
    if (sourceRel === targetRel) return false;
    if (targetRel.startsWith(`${sourceRel}/`)) return false;
  }
  return true;
}

function folderTarget(args: {
  typeName: string;
  typeid: string;
  relPath: string;
  absPath: string;
  label: string;
}): MarkdownFolderTarget {
  return {
    typeName: args.typeName,
    typeid: args.typeid,
    relPath: normalizeRelPath(args.relPath),
    absPath: args.absPath,
    label: args.label,
  };
}

function folderToolbar(
  target: MarkdownFolderTarget,
  onCreateFolder?: (target: MarkdownFolderTarget) => void,
): ToolbarAction[] | undefined {
  if (!onCreateFolder) return undefined;
  return [
    {
      id: `new-folder:${target.typeid}:${target.relPath || 'root'}`,
      icon: <FolderPlus />,
      label: `New folder in ${target.label}`,
      run: () => onCreateFolder(target),
      showBusyIndicator: false,
    },
  ];
}

function resolveAssetIcon(iconName: string | null | undefined): React.ReactNode {
  const Icon = lucideByName(iconName);
  return <Icon className="h-4 w-4 flex-shrink-0" />;
}

/** Count badge — reuses the existing `/search` count trick (limit=1).
 *  Honors the active filter so the chip reflects what the user actually sees. */
function MarkdownCountBadge({ filter }: { filter: AssetFilter }) {
  const [total, setTotal] = React.useState<number | null>(null);
  const filterKey = React.useMemo(() => {
    const p = new URLSearchParams();
    applyFilterToParams(p, filter);
    return p.toString();
  }, [filter]);
  React.useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    params.set('record_type', 'markdown');
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey]);
  if (total === null || total === 0) return null;
  return (
    <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
      {total > 999 ? '999+' : total}
    </span>
  );
}

/** Build the root-level toolbar: Scan + New. */
function rootToolbar(type: AssetTypeInfo, deps: MarkdownFolderRootDeps): ToolbarAction[] {
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
  if (deps.onNew) {
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
 * Build a Browseable for a folder at `(typeid, relPath, absPath)` with the
 * given display label. Children are lazy-loaded via fsStore.listDirectory
 * and filtered to `.md` files + subdirectories.
 */
function folderBrowseable(args: {
  typeName: string;
  typeid: string;
  relPath: string;
  absPath: string;
  label: string;
  kind: 'vault-root' | 'folder';
  folderPageSize: number;
  onCreateFolder?: (target: MarkdownFolderTarget) => void;
  onMoveItem?: (item: MarkdownDragItem, target: MarkdownFolderTarget) => Promise<void> | void;
}): Browseable {
  const { typeName, typeid, relPath, absPath, label, kind, folderPageSize, onCreateFolder, onMoveItem } = args;
  const target = folderTarget({ typeName, typeid, relPath, absPath, label });
  return {
    id: markdownFolderNodeId(typeid, absPath),
    kind,
    label,
    icon:
      kind === 'vault-root' ? (
        <Folder className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
      ) : (
        <Folder className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
      ),
    hasChildren: true,
    pointer: DockPointer.forAssetFolder(typeName, typeid, relPath),
    toolbar: folderToolbar(target, onCreateFolder),
    dragData: kind === 'folder'
      ? {
          kind: 'markdown-folder',
          id: `md-folder:${typeid}:${absPath}`,
          label,
          typeName,
          typeid,
          relPath: normalizeRelPath(relPath),
          absPath,
          isDir: true,
        }
      : undefined,
    canDrop: onMoveItem ? (data) => canDropMarkdownItem(target, data) : undefined,
    onDrop: onMoveItem
      ? (data) => {
          if (!isMarkdownDragItem(data)) return;
          return onMoveItem(data, target);
        }
      : undefined,
    listChildren: async (opts) => {
      // `refresh:true` comes from deep-link freshness in useBrowseableTree —
      // the leaf was missing from a previously-cached listing, so drop
      // fsStore.browseCache for this folder before refetching from disk.
      if (opts?.refresh) {
        fsStore.getState().invalidate(new TypeId(typeid), relPath || '/', 'browse');
      }
      const entries = await fsStore
        .getState()
        .listDirectory(new TypeId(typeid), relPath || '/');
      const items = [...(entries.items ?? [])]
        .filter((item) => item.is_dir || (item.name ?? '').toLowerCase().endsWith('.md'))
        .slice(0, folderPageSize);
      items.sort((a, b) => {
        if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
        return (a.name ?? '').localeCompare(b.name ?? '');
      });
      return items.map((item) => {
        const name = item.name ?? '';
        const childRel = relPath ? `${relPath}/${name}` : name;
        const childAbs = absPath ? `${absPath}/${name}` : `/${name}`;
        if (item.is_dir) {
          return folderBrowseable({
            typeName,
            typeid,
            relPath: childRel,
            absPath: childAbs,
            label: name,
            kind: 'folder',
            folderPageSize,
            onCreateFolder,
            onMoveItem,
          });
        }
        return {
          id: `md-file:${typeid}:${childAbs}`,
          kind: 'asset',
          label: name,
          icon: <FileText className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />,
          hasChildren: false as const,
          pointer: DockPointer.forAssetEditor(typeName, childAbs),
          dragData: {
            kind: 'markdown-file',
            id: `md-file:${typeid}:${childAbs}`,
            label: name,
            typeName,
            typeid,
            relPath: normalizeRelPath(childRel),
            absPath: childAbs,
            isDir: false,
          },
        };
      });
    },
  };
}

/** Mirror of backend ``apply_scope_filter`` for vault listing. Reads the
 *  unified ScopeFilter `{user, projects}`: a user vault is kept iff
 *  `sf.user`; a project vault is kept iff its `project_id` is in
 *  `sf.projects`. Empty `projects` array means no project vaults are kept. */
function keepVault(v: AssetTypeVault, filter: AssetFilter): boolean {
  if (v.scope === 'user') return filter.scope.user;
  if (v.scope === 'project') {
    return v.project_id !== null && filter.scope.projects.includes(v.project_id);
  }
  return false;
}

function findVaultForAbsPath(
  vaults: AssetTypeVault[],
  absPath: string,
): AssetTypeVault | null {
  // Pick the most specific (longest absPath) vault that is a prefix of `absPath`.
  let best: AssetTypeVault | null = null;
  for (const v of vaults) {
    if (absPath === v.absPath || absPath.startsWith(v.absPath + '/')) {
      if (!best || v.absPath.length > best.absPath.length) best = v;
    }
  }
  return best;
}

function findVaultForTypeidRel(
  vaults: AssetTypeVault[],
  typeid: string,
  relPath: string,
): AssetTypeVault | null {
  let best: AssetTypeVault | null = null;
  for (const v of vaults) {
    if (v.typeid !== typeid) continue;
    if (relPath === v.relPath || relPath.startsWith(v.relPath + (v.relPath ? '/' : ''))) {
      if (!best || v.relPath.length > best.relPath.length) best = v;
    }
  }
  return best;
}

/**
 * Build the Markdown root for the Obsidian-style folder tree. Children are
 * vault roots (from AssetTypeInfo.vaults); each vault's subtree is browsed
 * lazily via fsStore.listDirectory.
 */
export function markdownFolderRoot(
  type: AssetTypeInfo,
  deps: MarkdownFolderRootDeps,
): BrowseableRoot {
  const vaults = type.vaults ?? [];
  const folderPageSize = deps.folderPageSize ?? 500;
  const filter = deps.filter ?? DEFAULT_ASSET_FILTER;

  const vaultIcon = (v: AssetTypeVault): React.ReactNode => {
    if (v.scope === 'user') {
      return <UserIcon className="h-4 w-4 flex-shrink-0 text-muted-foreground" />;
    }
    if (v.scope === 'project') {
      return <Library className="h-4 w-4 flex-shrink-0 text-muted-foreground" />;
    }
    return <Folder className="h-4 w-4 flex-shrink-0 text-muted-foreground" />;
  };

  const buildVaultNode = (v: AssetTypeVault): Browseable => ({
    ...folderBrowseable({
      typeName: type.type_name,
      typeid: v.typeid,
      relPath: v.relPath,
      absPath: v.absPath,
      label: v.label,
      kind: 'vault-root',
      folderPageSize,
      onCreateFolder: deps.onCreateFolder,
      onMoveItem: deps.onMoveItem,
    }),
    icon: vaultIcon(v),
  });

  const visibleVaults = vaults.filter((v) => keepVault(v, filter));
  // Include filter signature so the tree refetches children when the user
  // toggles scope/picker — otherwise children are cached against the stale
  // visibleVaults from the previous expansion. Also include the source
  // ``vaults.length`` so the cache invalidates when the /assets/types
  // response arrives AFTER the initial render — otherwise the root keeps
  // serving the empty ``listChildren`` closure that was captured before
  // the API populated ``type.vaults``.
  const filterSig = `${filter.scope.user ? '1' : '0'}:${[...filter.scope.projects].sort().join(',')}:v${vaults.length}`;

  const root: BrowseableRoot = {
    id: `asset-type:${type.type_name}:${filterSig}`,
    kind: 'root',
    label: type.label,
    icon: resolveAssetIcon(type.icon),
    badge: <MarkdownCountBadge filter={filter} />,
    hasChildren: visibleVaults.length > 0,
    pointer: DockPointer.forAssetList(type.type_name),
    toolbar: rootToolbar(type, deps),
    listChildren: async () => visibleVaults.map(buildVaultNode),
    ownsPointer: (p) => {
      if (p.viewType !== ViewType.ASSETS) return false;
      // Own list/markdown, editor/markdown/..., and folder/markdown/...
      const flat = parseAssetPointer(p.pointer ?? null);
      if (flat.typeName === type.type_name) return true;
      const folder = DockPointer.parseAssetFolderPointer(p.pointer);
      return folder !== null && folder.typeName === type.type_name;
    },
    pathFor: async (p) => {
      // Folder pointer → walk vault + descendant folders
      const folder = DockPointer.parseAssetFolderPointer(p.pointer);
      if (folder) {
        const vault = findVaultForTypeidRel(vaults, folder.typeid, folder.relPath);
        if (!vault) return [root];
        const chain: Browseable[] = [root, buildVaultNode(vault)];
        if (folder.relPath === vault.relPath) return chain;
        const extra = folder.relPath
          .slice(vault.relPath.length)
          .replace(/^\/+/, '')
          .replace(/\/+$/, '');
        if (!extra) return chain;
        let currentRel = vault.relPath;
        let currentAbs = vault.absPath;
        for (const seg of extra.split('/')) {
          currentRel = currentRel ? `${currentRel}/${seg}` : seg;
          currentAbs = `${currentAbs}/${seg}`;
          chain.push(
            folderBrowseable({
              typeName: type.type_name,
              typeid: vault.typeid,
              relPath: currentRel,
              absPath: currentAbs,
              label: seg,
              kind: 'folder',
              folderPageSize,
              onCreateFolder: deps.onCreateFolder,
              onMoveItem: deps.onMoveItem,
            }),
          );
        }
        return chain;
      }

      // Editor pointer → walk vault + intermediate folders + leaf file
      const flat = parseAssetPointer(p.pointer ?? null);
      if (flat.mode === 'editor' && flat.typeName === type.type_name && flat.vfsPath) {
        const absPath = flat.vfsPath.startsWith('/') ? flat.vfsPath : `/${flat.vfsPath}`;
        const vault = findVaultForAbsPath(vaults, absPath);
        if (!vault) return [root];
        const chain: Browseable[] = [root, buildVaultNode(vault)];
        const remainder = absPath
          .slice(vault.absPath.length)
          .replace(/^\/+/, '')
          .replace(/\/+$/, '');
        if (!remainder) return chain;
        const segments = remainder.split('/');
        const fileName = segments.pop()!;
        let currentRel = vault.relPath;
        let currentAbs = vault.absPath;
        for (const seg of segments) {
          currentRel = currentRel ? `${currentRel}/${seg}` : seg;
          currentAbs = `${currentAbs}/${seg}`;
          chain.push(
            folderBrowseable({
              typeName: type.type_name,
              typeid: vault.typeid,
              relPath: currentRel,
              absPath: currentAbs,
              label: seg,
              kind: 'folder',
              folderPageSize,
              onCreateFolder: deps.onCreateFolder,
              onMoveItem: deps.onMoveItem,
            }),
          );
        }
        chain.push({
          id: `md-file:${vault.typeid}:${absPath}`,
          kind: 'asset',
          label: fileName,
          icon: <FileText className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />,
          hasChildren: false,
          pointer: DockPointer.forAssetEditor(type.type_name, absPath),
        });
        return chain;
      }

      return [root];
    },
  };
  return root;
}
