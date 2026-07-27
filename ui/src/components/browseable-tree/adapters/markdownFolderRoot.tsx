import React from 'react';
import { FileText, Folder, FolderPlus, Library, Network, Plus, RefreshCw, User as UserIcon } from 'lucide-react';
import { lucideByName } from '@src/lib/lucide-by-name';
import apiClient from '@sdk/client';
import { CountChip } from '@src/components/browseable-tree/CountChip';
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
import { scopeFilterKey, scopeIncludesUser, scopeProjectIds, type ScopeFilter } from '@src/lib/scope-filter';
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
    scope?: ScopeFilter,
    options?: { force?: boolean; orphanAction?: 'index' | 'ignore' | 'delete' },
  ) => Promise<{ indexed?: number } | void>;
  /** Called when the root-level "New" toolbar is clicked (falls back to the
   *  legacy flow which creates under .claude/docs). */
  onNew?: (typeName: string) => void;
  /** Called when a vault/folder wants a new child folder. */
  onCreateFolder?: (target: MarkdownFolderTarget) => void;
  /** Called when a markdown file/folder is dropped onto a folder target. */
  onMoveItem?: (item: MarkdownDragItem, target: MarkdownFolderTarget) => Promise<void> | void;
  /** Active filter — used by the count badge so it tracks scope/project. */
  filter?: AssetFilter;
  /** Open the docs knowledge browser for a vault root (its absolute vfs path).
   *  Wired by the host (AssetsPage) to navigation.openDock — toolbar actions are
   *  side-effects, so navigation is performed by the host, not here. */
  onOpenKnowledgeBrowser?: (absPath: string) => void;
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
  return <CountChip count={total} />;
}

/** Build the root-level toolbar: Scan + New. */
function rootToolbar(type: AssetTypeInfo, deps: MarkdownFolderRootDeps): ToolbarAction[] {
  const actions: ToolbarAction[] = [
    {
      id: `scan:${type.type_name}`,
      icon: <RefreshCw />,
      label: 'Scan for changes',
      run: async () => {
        // Reindex; resulting data_ops refresh the tree via useAssetTreeRefresh.
        await deps.indexType(type.type_name, deps.filter?.scope);
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
 * Fetch the COMPLETE set of markdown files under a vault root, honoring
 * ``.gitignore`` (backend ``/assets/markdown-files`` → ``walk_markdown_files``).
 * Returns vault-root-relative POSIX paths. Memoised per absolute root so the
 * vault node's ``listChildren`` and ``pathFor`` (deep-link) share one request.
 */
const _vaultFilesCache = new Map<string, Promise<string[]>>();

/** Test-only: drop the per-vault walk memoisation so each case fetches fresh. */
export function __resetVaultFilesCacheForTests(): void {
  _vaultFilesCache.clear();
}

function fetchVaultFiles(vaultAbsPath: string, refresh = false): Promise<string[]> {
  if (refresh) _vaultFilesCache.delete(vaultAbsPath);
  const cached = _vaultFilesCache.get(vaultAbsPath);
  if (cached) return cached;
  const params = new URLSearchParams({ root: vaultAbsPath });
  const p = apiClient
    .get(`/assets/markdown-files?${params.toString()}`)
    .then((d: unknown) => ((d as { files?: string[] } | null)?.files ?? []))
    .catch(() => [] as string[]);
  _vaultFilesCache.set(vaultAbsPath, p);
  return p;
}

/** Absolute path of ``prefixRel`` (vault-relative) under a vault root. */
function vaultAbsForPrefix(vaultAbsPath: string, prefixRel: string): string {
  const p = normalizeRelPath(prefixRel);
  return p ? `${vaultAbsPath.replace(/\/+$/, '')}/${p}` : vaultAbsPath;
}

/** VFS rel path of ``prefixRel`` under a vault (the DockPointer folder form). */
function vaultRelForPrefix(vaultRelPath: string, prefixRel: string): string {
  const p = normalizeRelPath(prefixRel);
  if (!p) return vaultRelPath;
  return vaultRelPath ? `${vaultRelPath}/${p}` : p;
}

/**
 * Immediate children (subfolders + ``.md`` files) directly under ``prefixRel``
 * within a vault, derived from the flat walk ``files``. Folders sort before
 * files; both alphabetical. Subfolder nodes recurse over the SAME ``files``
 * array (no extra fetch); the whole subtree comes from the one walk.
 */
export function childrenForPrefix(args: {
  typeName: string;
  typeid: string;
  vaultAbsPath: string;
  vaultRelPath: string;
  files: string[];
  prefixRel: string; // vault-relative dir, '' for the vault root
  onCreateFolder?: (target: MarkdownFolderTarget) => void;
  onMoveItem?: (item: MarkdownDragItem, target: MarkdownFolderTarget) => Promise<void> | void;
}): Browseable[] {
  const { typeName, typeid, vaultAbsPath, vaultRelPath, files, prefixRel, onCreateFolder, onMoveItem } = args;
  const norm = normalizeRelPath(prefixRel);
  const head = norm ? `${norm}/` : '';
  const folderNames = new Set<string>();
  const fileNames: string[] = [];
  for (const f of files) {
    if (head && !f.startsWith(head)) continue;
    const remainder = head ? f.slice(head.length) : f;
    if (!remainder) continue;
    const slash = remainder.indexOf('/');
    if (slash === -1) {
      fileNames.push(remainder);
    } else {
      folderNames.add(remainder.slice(0, slash));
    }
  }

  const folders: Browseable[] = [...folderNames]
    .sort((a, b) => a.localeCompare(b))
    .map((name) =>
      folderBrowseable({
        typeName, typeid, vaultAbsPath, vaultRelPath, files,
        prefixRel: norm ? `${norm}/${name}` : name,
        label: name,
        kind: 'folder',
        onCreateFolder, onMoveItem,
      }),
    );

  const fileLeaves: Browseable[] = fileNames
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const childRel = norm ? `${norm}/${name}` : name;
      const childAbs = vaultAbsForPrefix(vaultAbsPath, childRel);
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
          relPath: normalizeRelPath(vaultRelForPrefix(vaultRelPath, childRel)),
          absPath: childAbs,
          isDir: false,
        },
      };
    });

  return [...folders, ...fileLeaves];
}

/**
 * Build a Browseable for a folder (or the vault root) backed by the flat
 * gitignore-aware walk. Children are derived in-memory from ``files`` — no
 * per-folder filesystem listing — so a project-root file appears next to
 * ``docs/`` files. The vault root fetches the walk; folders reuse it.
 */
function folderBrowseable(args: {
  typeName: string;
  typeid: string;
  vaultAbsPath: string;
  vaultRelPath: string;
  prefixRel: string; // vault-relative dir, '' for the vault root
  label: string;
  kind: 'vault-root' | 'folder';
  files?: string[]; // present for descendants; the vault root fetches it
  onCreateFolder?: (target: MarkdownFolderTarget) => void;
  onMoveItem?: (item: MarkdownDragItem, target: MarkdownFolderTarget) => Promise<void> | void;
  onOpenKnowledgeBrowser?: (absPath: string) => void;
}): Browseable {
  const {
    typeName, typeid, vaultAbsPath, vaultRelPath, prefixRel,
    label, kind, files, onCreateFolder, onMoveItem, onOpenKnowledgeBrowser,
  } = args;
  // This folder's own paths derive from the vault root + its vault-relative prefix.
  const absPath = vaultAbsForPrefix(vaultAbsPath, prefixRel);
  const relPath = vaultRelForPrefix(vaultRelPath, prefixRel);
  const target = folderTarget({ typeName, typeid, relPath, absPath, label });
  // The knowledge-browser button sits only on the docs root (vault-root), which
  // has a single scannable path; subfolders don't get their own browser.
  const kbAction: ToolbarAction[] =
    kind === 'vault-root' && onOpenKnowledgeBrowser
      ? [
          {
            id: `kbrowser:${typeid}:${absPath}`,
            icon: <Network />,
            label: 'Open knowledge browser',
            run: () => onOpenKnowledgeBrowser(absPath),
            showBusyIndicator: false,
          },
        ]
      : [];
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
    toolbar: [...(folderToolbar(target, onCreateFolder) ?? []), ...kbAction],
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
      // The vault root owns the walk; `refresh` re-walks (deep-link freshness
      // when a leaf was missing from a cached listing). Descendants reuse the
      // already-fetched `files` array — no extra request.
      const walk = files ?? (await fetchVaultFiles(vaultAbsPath, !!opts?.refresh));
      return childrenForPrefix({
        typeName, typeid, vaultAbsPath, vaultRelPath, files: walk,
        prefixRel, onCreateFolder, onMoveItem,
      });
    },
  };
}

/** Mirror of backend ``apply_scope_filter`` for vault listing. Reads the
 *  unified ScopeFilter `{user, projects}`: a user vault is kept iff
 *  `sf.user`; a project vault is kept iff its Project id or legacy
 *  record_project_id is selected. Empty `projects` means no project vaults. */
function keepVault(v: AssetTypeVault, filter: AssetFilter): boolean {
  if (v.scope === 'user') return scopeIncludesUser(filter.scope);
  if (v.scope === 'project') {
    const selected = new Set(scopeProjectIds(filter.scope));
    return (
      (!!v.project_id && selected.has(v.project_id)) ||
      (!!v.record_project_id && selected.has(v.record_project_id))
    );
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
 * vault roots (from AssetTypeInfo.vaults); each vault's subtree comes from one
 * gitignore-aware project walk (``/assets/markdown-files``), built in memory.
 */
export function markdownFolderRoot(
  type: AssetTypeInfo,
  deps: MarkdownFolderRootDeps,
): BrowseableRoot {
  const vaults = type.vaults ?? [];
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
      vaultAbsPath: v.absPath,
      vaultRelPath: v.relPath,
      prefixRel: '',
      label: v.label,
      kind: 'vault-root',
      onCreateFolder: deps.onCreateFolder,
      onMoveItem: deps.onMoveItem,
      onOpenKnowledgeBrowser: deps.onOpenKnowledgeBrowser,
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
  const filterSig = `${scopeFilterKey(filter.scope)}:v${vaults.length}`;

  const root: BrowseableRoot = {
    id: `asset-type:${type.type_name}:${filterSig}`,
    kind: 'root',
    label: type.label,
    icon: resolveAssetIcon(type.icon),
    badge: <MarkdownCountBadge filter={filter} />,
    hasChildren: visibleVaults.length > 0,
    pointer: DockPointer.forAssetList(type.type_name),
    toolbar: rootToolbar(type, deps),
    listChildren: () => Promise.resolve(visibleVaults.map(buildVaultNode)),
    ownsPointer: (p) => {
      // A canonical VFS resource is owned independently of the route used to
      // present it (editor, Assets Files, Explorer).
      const resourcePath = p.resourceVfsPath?.machinePath;
      if (resourcePath && !!findVaultForAbsPath(visibleVaults, resourcePath)) return true;
      if (p.viewType !== ViewType.ASSETS) return false;
      // Non-resource routes retain their semantic ownership.
      const flat = parseAssetPointer(p.pointer ?? null);
      if (flat.typeName === type.type_name) return true;
      const folder = DockPointer.parseAssetFolderPointer(p.pointer);
      return folder !== null && folder.typeName === type.type_name;
    },
    pathFor: (p) => {
      // Folder pointer → walk vault + descendant folders
      const folder = DockPointer.parseAssetFolderPointer(p.pointer);
      if (folder) {
        const vault = findVaultForTypeidRel(vaults, folder.typeid, folder.relPath);
        if (!vault) return Promise.resolve([root]);
        const chain: Browseable[] = [root, buildVaultNode(vault)];
        if (folder.relPath === vault.relPath) return Promise.resolve(chain);
        const extra = folder.relPath
          .slice(vault.relPath.length)
          .replace(/^\/+/, '')
          .replace(/\/+$/, '');
        if (!extra) return Promise.resolve(chain);
        let currentPrefix = '';
        for (const seg of extra.split('/')) {
          currentPrefix = currentPrefix ? `${currentPrefix}/${seg}` : seg;
          chain.push(
            folderBrowseable({
              typeName: type.type_name,
              typeid: vault.typeid,
              vaultAbsPath: vault.absPath,
              vaultRelPath: vault.relPath,
              prefixRel: currentPrefix,
              label: seg,
              kind: 'folder',
              onCreateFolder: deps.onCreateFolder,
              onMoveItem: deps.onMoveItem,
            }),
          );
        }
        return Promise.resolve(chain);
      }

      // VFS resource → walk vault + intermediate folders + leaf file,
      // regardless of whether the active route is editor, fs, or Explorer.
      const resourcePath = p.resourceVfsPath?.machinePath;
      if (resourcePath) {
        const absPath = resourcePath.startsWith('/') ? resourcePath : `/${resourcePath}`;
        const vault = findVaultForAbsPath(vaults, absPath);
        if (!vault) return Promise.resolve([root]);
        const chain: Browseable[] = [root, buildVaultNode(vault)];
        const remainder = absPath
          .slice(vault.absPath.length)
          .replace(/^\/+/, '')
          .replace(/\/+$/, '');
        if (!remainder) return Promise.resolve(chain);
        const segments = remainder.split('/');
        const fileName = segments.pop()!;
        let currentPrefix = '';
        for (const seg of segments) {
          currentPrefix = currentPrefix ? `${currentPrefix}/${seg}` : seg;
          chain.push(
            folderBrowseable({
              typeName: type.type_name,
              typeid: vault.typeid,
              vaultAbsPath: vault.absPath,
              vaultRelPath: vault.relPath,
              prefixRel: currentPrefix,
              label: seg,
              kind: 'folder',
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
        return Promise.resolve(chain);
      }

      return Promise.resolve([root]);
    },
  };
  return root;
}
