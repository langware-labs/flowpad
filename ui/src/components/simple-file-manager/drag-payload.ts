import type { TypeId } from '@sdk';
import type { FsDragEntry, FsDragItem } from '@src/components/browseable-tree/adapters/fsFolderRoot';
import type { FileItem } from './types';

function toEntry(f: FileItem): FsDragEntry {
  return {
    relPath: f.path.replace(/^\/+/, ''),
    isDir: f.type === 'folder',
    label: f.name,
  };
}

/**
 * Build the drag payload for a file-manager row.
 *
 * When the dragged row is part of the current multi-selection, the payload
 * carries EVERY selected row (`items`), so a drop copies the whole selection;
 * otherwise it is a plain single-row payload. Same `FsDragItem` grammar the
 * navigator's Files tree writes, so both surfaces share drop targets.
 */
export function buildRowDragItem(
  item: FileItem,
  selectedIds: Set<string>,
  files: FileItem[],
  typeid: TypeId,
): FsDragItem {
  const dragged =
    selectedIds.has(item.id) && selectedIds.size > 1 ? files.filter((f) => selectedIds.has(f.id)) : [item];
  const entries = dragged.map(toEntry);
  const primary = toEntry(item);
  return {
    kind: 'fs-item',
    id: `${primary.isDir ? 'fs-folder' : 'fs-file'}:${typeid.toString()}:${primary.relPath}`,
    label: primary.label,
    relPath: primary.relPath,
    isDir: primary.isDir,
    ...(entries.length > 1 ? { items: entries } : {}),
  };
}

const GHOST_MAX_ROWS = 4;

/**
 * Build an ephemeral drag-image element listing every dragged name (capped,
 * with a "+N more" tail), so a multi-selection drag visibly carries all its
 * items. The element must be in the DOM when `setDragImage` samples it —
 * append it offscreen and remove it right after the drag starts.
 */
export function attachMultiDragGhost(e: React.DragEvent, labels: string[]): void {
  const ghost = document.createElement('div');
  ghost.style.position = 'fixed';
  ghost.style.top = '-1000px';
  ghost.style.left = '-1000px';
  ghost.style.pointerEvents = 'none';
  ghost.className = 'flex flex-col gap-0.5 rounded-md border border-border bg-background px-2 py-1.5 text-xs shadow-md';
  for (const label of labels.slice(0, GHOST_MAX_ROWS)) {
    const row = document.createElement('div');
    row.textContent = label;
    row.className = 'max-w-[220px] truncate';
    ghost.appendChild(row);
  }
  if (labels.length > GHOST_MAX_ROWS) {
    const more = document.createElement('div');
    more.textContent = `+${labels.length - GHOST_MAX_ROWS} more`;
    more.className = 'text-muted-foreground';
    ghost.appendChild(more);
  }
  document.body.appendChild(ghost);
  e.dataTransfer.setDragImage(ghost, 12, 12);
  // Safe to drop from the DOM once the browser has sampled the image.
  setTimeout(() => ghost.remove(), 0);
}
