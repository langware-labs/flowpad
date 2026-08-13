import { t } from '@lingui/core/macro';
import React, { type ReactNode } from 'react';
import { FolderPlus, Pencil, Trash2 } from 'lucide-react';
import { Group, type GroupChildren, type IEntity } from '@sdk';
import type { DockPointer } from '@src/navigation';
import { renderIconValue } from '@src/lib/icon-value';
import { refreshNode } from '../refresh-store';
import type { Browseable, BrowseableDragData, BrowseableRoot, ToolbarAction } from '../types';

/**
 * groupRoot — ONE generic browseable adapter for entities-groups trees
 * (docs/entities-groups.md). Any feature that wants "X in folders" composes
 * this with a namespace + leaf config; all folder mechanics (create, rename,
 * move-up delete, drag-move) live HERE, delegated one-line to the SDK —
 * consumers contain zero folder logic.
 *
 * Picker semantics: the returned handle's `onNavigate` resolves leaf clicks
 * to `onSelectLeaf(entity)` when configured (the menu's selection), and
 * falls through to the provided `navigate` for everything else (e.g. the
 * leaf "open" toolbar action navigating for real).
 */

export interface GroupLeafView {
  label: string;
  icon?: ReactNode;
  /** Real navigation target (also the picker selection key). */
  pointer: DockPointer | null;
  toolbar?: ToolbarAction[];
}

export interface GroupRootConfig {
  /** Tree identity — which namespace this root browses. */
  namespace: string;
  /** Root row label (e.g. "Prompt Library"). */
  label: string;
  /** Entity types shown as leaves. */
  leafTypes: string[];
  /** Scope listings to a project (optional). */
  projectId?: string | null;
  /** Map a leaf entity to its row. */
  leafToBrowseable: (entity: IEntity) => GroupLeafView;
  /** Picker mode: leaf click selects instead of navigating. */
  onSelectLeaf?: (entity: IEntity) => void | Promise<void>;
  /** Fallback navigation (folders never navigate; leaves do when no picker). */
  navigate?: (pointer: DockPointer) => void;
  /** Which folder mechanics to expose. */
  capabilities?: { createFolder?: boolean; rename?: boolean; delete?: boolean; move?: boolean };
  /** Async name prompt (from `useMenuDialogs`). Required by create/rename. */
  requestName?: (title: string, opts?: { placeholder?: string; defaultValue?: string }) => Promise<string | null>;
  /** Async confirmation (from `useMenuDialogs`). Required by delete. */
  confirm?: (title: string, description?: string) => Promise<boolean>;
  /** Extra toolbar entries on folder rows AND the root (e.g. "New prompt"). */
  extraContainerToolbar?: (groupId: string | null, refresh: () => void) => ToolbarAction[];
  /** Root row icon. */
  rootIcon?: ReactNode;
}

export interface GroupRootHandle {
  root: BrowseableRoot;
  /** Wire as the tree's `onNavigate`: picker-select for leaves, else navigate. */
  onNavigate: (pointer: DockPointer) => void;
}

const DRAG_FOLDER = 'group-folder';
const DRAG_LEAF = 'group-leaf';

function pointerKey(pointer: DockPointer): string {
  return `${(pointer as any).viewType ?? ''}:${(pointer as any).pointer ?? ''}`;
}

export function groupRoot(cfg: GroupRootConfig): GroupRootHandle {
  const rootId = `group-root:${cfg.namespace}`;
  const caps = { createFolder: true, rename: true, delete: true, move: true, ...(cfg.capabilities ?? {}) };
  /** pointerKey -> leaf entity, rebuilt as levels load; powers picker clicks. */
  const leafByPointer = new Map<string, IEntity>();
  const refresh = () => refreshNode(rootId);

  const dragForFolder = (group: Group): BrowseableDragData => ({
    kind: DRAG_FOLDER,
    id: group.id,
    label: group.name,
  });

  const dragForLeaf = (entity: IEntity, label: string): BrowseableDragData => ({
    kind: DRAG_LEAF,
    id: String(entity.id),
    label,
    entityType: String(entity.type),
  });

  const canDrop = (drag: BrowseableDragData, targetGroupId: string | null) =>
    caps.move && (drag.kind === DRAG_FOLDER || drag.kind === DRAG_LEAF) && drag.id !== targetGroupId;

  const onDrop = async (drag: BrowseableDragData, targetGroupId: string | null) => {
    // One-line SDK delegations — validation (cycles, namespaces, projects)
    // is backend-owned; a rejection simply leaves the tree unchanged.
    if (drag.kind === DRAG_FOLDER) {
      const group = await Group.byId(drag.id);
      await group?.move(targetGroupId);
    } else if (drag.kind === DRAG_LEAF) {
      const entity = await Group.resolveEntity(String(drag.entityType), drag.id);
      await entity?.setGroup(targetGroupId);
    }
    refresh();
  };

  const containerToolbar = (group: Group | null): ToolbarAction[] => {
    const groupId = group?.id ?? null;
    const actions: ToolbarAction[] = [];
    if (caps.createFolder && cfg.requestName) {
      actions.push({
        id: `new-folder:${groupId ?? 'root'}`,
        icon: <FolderPlus />,
        label: t`New folder`,
        run: async () => {
          const name = await cfg.requestName!('New folder', { placeholder: t`Folder name` });
          if (!name) return;
          await Group.create({ name, namespace: cfg.namespace, groupId, projectId: cfg.projectId ?? null });
          refresh();
        },
      });
    }
    if (group && caps.rename && cfg.requestName) {
      actions.push({
        id: `rename:${group.id}`,
        icon: <Pencil />,
        label: t`Rename folder`,
        run: async () => {
          const name = await cfg.requestName!('Rename folder', { defaultValue: group.name });
          if (!name || name === group.name) return;
          await group.rename(name);
          refresh();
        },
      });
    }
    if (group && caps.delete && cfg.confirm) {
      actions.push({
        id: `delete:${group.id}`,
        icon: <Trash2 />,
        label: t`Delete folder (children move up)`,
        run: async () => {
          const ok = await cfg.confirm!(
            `Delete "${group.name}"?`,
            'Its folders and items move up one level — nothing inside is deleted.',
          );
          if (!ok) return;
          await group.deleteGroup();
          refresh();
        },
      });
    }
    actions.push(...(cfg.extraContainerToolbar?.(groupId, refresh) ?? []));
    return actions;
  };

  const leafNode = (entity: IEntity): Browseable => {
    const view = cfg.leafToBrowseable(entity);
    if (view.pointer) leafByPointer.set(pointerKey(view.pointer), entity);
    return {
      id: `group-leaf:${entity.type}:${entity.id}`,
      kind: 'asset',
      label: view.label,
      icon: view.icon,
      hasChildren: false,
      pointer: view.pointer,
      toolbar: view.toolbar,
      dragData: caps.move ? dragForLeaf(entity, view.label) : undefined,
    };
  };

  const folderNode = (group: Group): Browseable => ({
    id: `group-folder:${group.id}`,
    kind: 'folder',
    label: group.name,
    icon: renderIconValue(group.icon ?? 'Folder', { color: group.color }),
    hasChildren: 'unknown',
    pointer: null,
    toolbar: containerToolbar(group),
    dragData: caps.move ? dragForFolder(group) : undefined,
    canDrop: (drag) => canDrop(drag, group.id),
    onDrop: (drag) => onDrop(drag, group.id),
    listChildren: async () => {
      const children = await group.listChildren({ types: cfg.leafTypes });
      return toRows(children);
    },
  });

  const toRows = (children: GroupChildren): Browseable[] => [
    ...children.groups.map(folderNode),
    ...children.members.map(leafNode),
  ];

  const root: BrowseableRoot = {
    id: rootId,
    kind: 'root',
    label: cfg.label,
    icon: cfg.rootIcon,
    hasChildren: 'unknown',
    pointer: null,
    toolbar: containerToolbar(null),
    canDrop: (drag) => canDrop(drag, null),
    onDrop: (drag) => onDrop(drag, null),
    listChildren: async () => {
      const children = await Group.listRoot(cfg.namespace, {
        types: cfg.leafTypes,
        projectId: cfg.projectId ?? null,
      });
      return toRows(children);
    },
    ownsPointer: () => false,
    pathFor: async () => [],
  };

  const onNavigate = (pointer: DockPointer) => {
    const entity = leafByPointer.get(pointerKey(pointer));
    if (entity && cfg.onSelectLeaf) {
      void cfg.onSelectLeaf(entity);
      return;
    }
    cfg.navigate?.(pointer);
  };

  return { root, onNavigate };
}
