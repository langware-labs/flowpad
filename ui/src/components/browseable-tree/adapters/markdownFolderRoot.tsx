import React from 'react';
import { FileText, Folder, Plus, RefreshCw } from 'lucide-react';
import { lucideByName } from '@src/lib/lucide-by-name';
import apiClient from '@sdk/client';
import { fsStore, TypeId } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';
import type { AssetTypeInfo, AssetTypeVault } from '@src/hooks/use-asset-types';
import type {
  Browseable,
  BrowseableRoot,
  ToolbarAction,
} from '@src/components/browseable-tree/types';
import { parseAssetPointer } from './assetTypeRoot';

export interface MarkdownFolderRootDeps {
  /** Reindex callback for the "Scan" toolbar button. */
  indexType: (typeName: string) => Promise<{ indexed?: number } | void>;
  /** Called when the root-level "New" toolbar is clicked (falls back to the
   *  legacy flow which creates under .claude/docs). */
  onNew?: (typeName: string) => void;
  /** Called after a successful scan. */
  onScanComplete?: (typeName: string) => void;
  /** Max entries to fetch per folder from the filesystem. Default 500. */
  folderPageSize?: number;
}

function resolveAssetIcon(iconName: string | null | undefined): React.ReactNode {
  const Icon = lucideByName(iconName);
  return <Icon className="h-4 w-4 flex-shrink-0" />;
}

/** Count badge — reuses the existing `/search` count trick (limit=1). */
function MarkdownCountBadge() {
  const [total, setTotal] = React.useState<number | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    apiClient
      .get('/search?record_type=markdown&offset=0&limit=1')
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
  }, []);
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
        await deps.indexType(type.type_name);
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
}): Browseable {
  const { typeName, typeid, relPath, absPath, label, kind, folderPageSize } = args;
  return {
    id: `md-folder:${typeid}:${absPath || '/'}`,
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
    listChildren: async () => {
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
          });
        }
        return {
          id: `md-file:${typeid}:${childAbs}`,
          kind: 'asset',
          label: name,
          icon: <FileText className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />,
          hasChildren: false as const,
          pointer: DockPointer.forAssetEditor(typeName, childAbs),
        };
      });
    },
  };
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

  const buildVaultNode = (v: AssetTypeVault): Browseable =>
    folderBrowseable({
      typeName: type.type_name,
      typeid: v.typeid,
      relPath: v.relPath,
      absPath: v.absPath,
      label: v.label,
      kind: 'vault-root',
      folderPageSize,
    });

  const root: BrowseableRoot = {
    id: `asset-type:${type.type_name}`,
    kind: 'root',
    label: type.label,
    icon: resolveAssetIcon(type.icon),
    badge: <MarkdownCountBadge />,
    hasChildren: vaults.length > 0,
    pointer: DockPointer.forAssetList(type.type_name),
    toolbar: rootToolbar(type, deps),
    listChildren: async () => vaults.map(buildVaultNode),
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
