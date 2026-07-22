import type { ReactNode } from 'react';
import type { DockPointer } from '@src/navigation/DockPointer';
import type { BrowseableRoot, ToolbarAction } from '../types';

/**
 * A single flat row spec. Each becomes its own top-level `BrowseableRoot` (a
 * leaf root), so a flat list renders with NO parent header row and NO
 * indentation — the navigator's own header carries the title/count/actions.
 */
export interface FlatEntityRow {
  id: string;
  label: string;
  pointer: DockPointer | null;
  icon?: ReactNode;
  badge?: ReactNode;
  content?: ReactNode;
  rowClassName?: string;
  /** Topic tag — makes the row highlightable + bus-observable (see types.ts). */
  topic?: string;
  selectionKey?: string;
  toolbar?: ToolbarAction[];
  onRename?: (newName: string) => void | Promise<void>;
}

/**
 * Build a flat list of leaf roots from row specs. Selection is the standard
 * pointer-string match (URL-first); `pathFor` returns just the row itself, so
 * deep-link auto-expand is a no-op (there are no descendants).
 */
export function flatEntityRoots(rows: FlatEntityRow[]): BrowseableRoot[] {
  return rows.map((row) => {
    const root = {
      kind: 'root' as const,
      id: row.id,
      label: row.label,
      icon: row.icon,
      badge: row.badge,
      content: row.content,
      rowClassName: row.rowClassName,
      topic: row.topic,
      selectionKey: row.selectionKey,
      toolbar: row.toolbar,
      onRename: row.onRename,
      pointer: row.pointer,
      hasChildren: false as const,
      ownsPointer: (p: DockPointer) =>
        !!row.pointer && p.viewType === row.pointer.viewType && p.pointer === row.pointer.pointer,
      pathFor: () => Promise.resolve([root]),
    } as BrowseableRoot;
    return root;
  });
}
