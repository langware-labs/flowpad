import { t } from '@lingui/core/macro';
import React, { type ReactNode } from 'react';
import { FolderPlus, Pencil, Trash2 } from 'lucide-react';
import { Group, type GroupChildren, type GroupLeafMatch, type IEntity } from '@sdk';
import type { DockPointer } from '@src/navigation';
import { FlowIcon } from '@sdk/react/FlowIcon';
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
  /** A full-row body — the tree's own `Browseable.content` slot. */
  content?: ReactNode;
}

/** Manual order of a folder's members: the consumer owns where the order is stored. */
export interface GroupMemberOrder {
  sort: (members: IEntity[]) => IEntity[];
  /** Persist `dragId` next to its anchor among `siblings` (the container's members, dragged one included). */
  reorder: (siblings: IEntity[], dragId: string, anchor: { afterId?: string; beforeId?: string }) => Promise<void>;
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
  /** Which entities of `leafTypes` are leaves of this tree (built by the consumer). */
  leafMatch?: GroupLeafMatch;
  /** Members keep a manual order (drag between rows) instead of sorting by name. */
  order?: GroupMemberOrder;
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
  /** Ask for a name and create a top-level folder — for a host whose tree shows no root row. */
  newFolder: () => Promise<void>;
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
  /** Container (group id, '' for the root) -> its members as last listed, in display order. */
  const membersOf = new Map<string, IEntity[]>();
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

  const moveLeaf = async (type: string, id: string, groupId: string | null) => {
    const entity = await Group.resolveEntity(type, id);
    await entity?.setGroup(groupId);
  };

  const createFolder = async (groupId: string | null) => {
    const name = await cfg.requestName?.('New folder', { placeholder: t`Folder name` });
    if (!name) return;
    await Group.create({ name, namespace: cfg.namespace, groupId, projectId: cfg.projectId ?? null });
    refresh();
  };

  const onDrop = async (drag: BrowseableDragData, targetGroupId: string | null) => {
    // One-line SDK delegations — validation (cycles, namespaces, projects)
    // is backend-owned; a rejection simply leaves the tree unchanged.
    if (drag.kind === DRAG_FOLDER) {
      const group = await Group.byId(drag.id);
      await group?.move(targetGroupId);
    } else if (drag.kind === DRAG_LEAF) {
      await moveLeaf(String(drag.entityType), drag.id, targetGroupId);
    }
    refresh();
  };

  /** A drop between two member rows: into this container first if it came from another, then into the gap. */
  const reorderIn = (groupId: string | null): Browseable['reorderChildren'] =>
    cfg.order &&
    (async (dragId, anchor) => {
      const dragged = [...membersOf.values()].flat().find((m) => String(m.id) === dragId);
      if (!dragged) return onDrop({ kind: DRAG_FOLDER, id: dragId, label: '' }, groupId);
      if ((dragged.group_id ?? null) !== groupId) await moveLeaf(String(dragged.type), dragId, groupId);
      const siblings = (membersOf.get(groupId ?? '') ?? []).filter((m) => String(m.id) !== dragId);
      await cfg.order!.reorder([...siblings, dragged], dragId, anchor);
      refresh();
    });

  const containerToolbar = (group: Group | null): ToolbarAction[] => {
    const groupId = group?.id ?? null;
    const actions: ToolbarAction[] = [];
    if (caps.createFolder && cfg.requestName) {
      actions.push({
        id: `new-folder:${groupId ?? 'root'}`,
        icon: <FolderPlus />,
        label: t`New folder`,
        run: () => createFolder(groupId),
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
      content: view.content,
      dragData: caps.move ? dragForLeaf(entity, view.label) : undefined,
    };
  };

  const folderNode = (group: Group): Browseable => ({
    id: `group-folder:${group.id}`,
    kind: 'folder',
    label: group.name,
    icon: <FlowIcon icon={group.icon ?? 'Folder'} className="h-4 w-4" color={group.color ?? undefined} />,
    hasChildren: 'unknown',
    pointer: null,
    toolbar: containerToolbar(group),
    dragData: caps.move ? dragForFolder(group) : undefined,
    canDrop: (drag) => canDrop(drag, group.id),
    onDrop: (drag) => onDrop(drag, group.id),
    reorderChildren: reorderIn(group.id),
    listChildren: async () => {
      const children = await group.listChildren({ types: cfg.leafTypes, leafMatch: cfg.leafMatch });
      return toRows(children, group.id);
    },
  });

  const toRows = (children: GroupChildren, groupId: string | null): Browseable[] => {
    const members = cfg.order ? cfg.order.sort(children.members) : children.members;
    membersOf.set(groupId ?? '', members);
    return [...children.groups.map(folderNode), ...members.map(leafNode)];
  };

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
    reorderChildren: reorderIn(null),
    listChildren: async () => {
      const children = await Group.listRoot(cfg.namespace, {
        types: cfg.leafTypes,
        projectId: cfg.projectId ?? null,
        leafMatch: cfg.leafMatch,
      });
      return toRows(children, null);
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

  return { root, onNavigate, newFolder: () => createFolder(null) };
}
