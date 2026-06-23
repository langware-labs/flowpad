import React from 'react';
import { FilePlus, FolderPlus, Trash2 } from 'lucide-react';
import { fsManager, fsStore, TypeId } from '@sdk';
import { lucideByName } from '@src/lib/lucide-by-name';
import { DockPointer } from '@src/navigation/DockPointer';
import { DEFAULT_WIKI_SPACE } from '@src/navigation/asset-doc-types';
import type { Browseable, ToolbarAction } from '@src/components/browseable-tree/types';
import { showDeleteAssetModal } from '@src/components/assets/delete-asset-modal';
import { showInputPrompt } from '@src/components/ui/input-prompt-modal';
import { refreshNode } from '@src/components/browseable-tree/refresh-store';

/**
 * Skill folder adapter — bridges a skill's on-disk folder into the Browseable
 * protocol so a skill row in the Assets sidebar expands into its files/folders
 * (one unified tree, no second panel). Files open in the code editor; folders
 * recurse. Create-file / create-folder / delete live as row toolbar actions,
 * all routed through `fsManager` against the local compute node.
 */

const DEFAULT_PAGE_SIZE = 500;
// Single shared TypeId for the local compute node (built from the canonical
// space constant, mirroring AssetDocPointer). Hoisted so every create/delete/
// list action reuses one instance instead of allocating per call.
const COMPUTE_NODE_ID = new TypeId('compute_node', DEFAULT_WIKI_SPACE);

// Extension → lucide icon name. Module-level so it isn't rebuilt per file row.
const FILE_EXT_ICONS: Record<string, string> = {
  py: 'FileCode', js: 'FileCode', ts: 'FileCode', tsx: 'FileCode', jsx: 'FileCode',
  json: 'FileJson', md: 'FileText', txt: 'FileText', yaml: 'FileText', yml: 'FileText',
  png: 'FileImage', jpg: 'FileImage', jpeg: 'FileImage', gif: 'FileImage', svg: 'FileImage',
};

export function skillFolderNodeId(absPath: string): string {
  return `skill-folder:${absPath || '/'}`;
}

/** Compute-node-relative path = absolute disk path with the leading slash stripped. */
function relFromAbs(absPath: string): string {
  return absPath.replace(/^\/+/, '');
}

function fileIcon(name: string): React.ReactNode {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  const Icon = lucideByName(FILE_EXT_ICONS[ext] ?? 'File');
  return <Icon className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />;
}

/** Create-file / create-folder actions for the folder at `absPath`. After a
 *  write the folder's own node (`selfId`) is refreshed so the new item shows. */
export function skillCreateActions(absPath: string, selfId: string): ToolbarAction[] {
  const rel = relFromAbs(absPath);
  return [
    {
      id: `new-file:${absPath}`,
      icon: <FilePlus />,
      label: 'New file',
      run: () =>
        showInputPrompt({
          title: 'Create File',
          placeholder: 'Enter file name',
          onConfirm: async (name) => {
            await fsManager.writeFile(COMPUTE_NODE_ID, `${rel}/${name}`.replace(/\/+/g, '/'), '');
            refreshNode(selfId);
          },
        }),
      showBusyIndicator: false,
    },
    {
      id: `new-folder:${absPath}`,
      icon: <FolderPlus />,
      label: 'New folder',
      run: () =>
        showInputPrompt({
          title: 'Create Folder',
          placeholder: 'Enter folder name',
          onConfirm: async (name) => {
            await fsManager.mkdir(COMPUTE_NODE_ID, `${rel}/${name}`.replace(/\/+/g, '/'));
            refreshNode(selfId);
          },
        }),
      showBusyIndicator: false,
    },
  ];
}

/** Delete action for a file/folder. On success the PARENT node
 *  (`parentRefreshId`) is refreshed so the deleted row drops out. */
function deleteAction(absPath: string, label: string, parentRefreshId: string): ToolbarAction {
  return {
    id: `delete:${absPath}`,
    icon: <Trash2 />,
    label: `Delete ${label}`,
    run: () =>
      showDeleteAssetModal({
        name: label,
        onConfirm: async () => {
          await fsManager.delete(COMPUTE_NODE_ID, relFromAbs(absPath));
        },
        onAfterDelete: () => refreshNode(parentRefreshId),
      }),
    showBusyIndicator: false,
  };
}

function folderNode(absPath: string, label: string, parentRefreshId: string, pageSize: number): Browseable {
  const selfId = skillFolderNodeId(absPath);
  const FolderIcon = lucideByName('Folder');
  return {
    id: selfId,
    kind: 'folder',
    label,
    icon: <FolderIcon className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />,
    hasChildren: 'unknown',
    pointer: null, // folder click only toggles
    toolbar: [...skillCreateActions(absPath, selfId), deleteAction(absPath, label, parentRefreshId)],
    listChildren: skillFolderListChildren(absPath, selfId, pageSize),
  };
}

/**
 * Build the `listChildren` loader for the folder at `absPath`. Children:
 * subfolders recurse (refreshing themselves on create, the parent on delete),
 * files open in the code editor and can be deleted.
 */
export function skillFolderListChildren(
  absPath: string,
  selfId: string,
  pageSize: number = DEFAULT_PAGE_SIZE,
): (opts?: { refresh?: boolean }) => Promise<Browseable[]> {
  return async (opts) => {
    const rel = relFromAbs(absPath) || '/';
    if (opts?.refresh) {
      fsStore.getState().invalidate(COMPUTE_NODE_ID, rel, 'browse');
    }
    const entries = await fsStore.getState().listDirectory(COMPUTE_NODE_ID, rel);
    const items = [...(entries.items ?? [])]
      .filter((item) => !(item.name ?? '').startsWith('.'))
      .slice(0, pageSize);
    items.sort((a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      return (a.name ?? '').localeCompare(b.name ?? '');
    });
    return items.map((item) => {
      const name = item.name ?? '';
      const childAbs = absPath ? `${absPath}/${name}` : `/${name}`;
      if (item.is_dir) {
        return folderNode(childAbs, name, selfId, pageSize);
      }
      return {
        id: `skill-file:${childAbs}`,
        kind: 'asset',
        label: name,
        icon: fileIcon(name),
        hasChildren: false as const,
        pointer: DockPointer.forAssetEditor('code', childAbs),
        toolbar: [deleteAction(childAbs, name, selfId)],
      };
    });
  };
}
