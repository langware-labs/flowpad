import type { BrowseableDragData, DroppedFileEntry } from './types';

/**
 * The cross-surface drag contract for Browseable containers. Every Browseable
 * renderer (tree rows, desktop-grid tiles) writes the SAME payload at drag
 * start, so a row dragged from a tree can drop on a grid tile and vice versa
 * — one container protocol, OS-style.
 *
 * Read-side rules (HTML5 constraint): during `dragover` the payload body is
 * unreadable — only `e.dataTransfer.types` is visible — so droppability for a
 * FOREIGN drag (one that started in another component tree) can only be gated
 * on MIME presence; the full `canDrop(dragData)` check runs at drop time via
 * `readBrowseableDrag`. Renderers keep their own lifted-state fast path for
 * intra-surface drags, where the full payload IS available during dragover.
 */
export const BROWSEABLE_DRAG_MIME = 'application/x-flowpad-browseable';

export function writeBrowseableDrag(e: React.DragEvent, dragData: BrowseableDragData): void {
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData(BROWSEABLE_DRAG_MIME, JSON.stringify(dragData));
  e.dataTransfer.setData('text/plain', dragData.label);
}

export function hasBrowseableDrag(e: React.DragEvent): boolean {
  return e.dataTransfer.types.includes(BROWSEABLE_DRAG_MIME);
}

export function readBrowseableDrag(e: React.DragEvent): BrowseableDragData | null {
  const raw = e.dataTransfer.getData(BROWSEABLE_DRAG_MIME);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as BrowseableDragData;
    return parsed && typeof parsed.id === 'string' && typeof parsed.kind === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/** True when the drag carries OS files (Finder/Explorer), readable pre-drop. */
export function hasExternalFilesDrag(e: React.DragEvent): boolean {
  return e.dataTransfer.types.includes('Files');
}

/**
 * Flatten an external OS drop into files with drop-relative paths.
 *
 * Uses the (WebKit-prefixed but universally shipped) `webkitGetAsEntry` walk so
 * a dropped DIRECTORY yields every file under it with its nested `relPath`;
 * plain file drops fall back to `dataTransfer.files`. Entry handles die once
 * the drop event finishes, so callers must invoke this synchronously from the
 * drop handler (before any await) — hence items are snapshotted first.
 */
export async function collectDroppedEntries(dataTransfer: DataTransfer): Promise<DroppedFileEntry[]> {
  const items = Array.from(dataTransfer.items ?? []);
  const entries = items
    .filter((item) => item.kind === 'file')
    .map((item) => (item.webkitGetAsEntry ? item.webkitGetAsEntry() : null));
  if (!entries.some(Boolean)) {
    return Array.from(dataTransfer.files ?? []).map((file) => ({ file, relPath: file.name }));
  }

  const out: DroppedFileEntry[] = [];
  const readEntry = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
      out.push({ file, relPath: prefix ? `${prefix}/${entry.name}` : entry.name });
      return;
    }
    if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      // readEntries returns results in chunks; loop until an empty batch.
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        for (const child of batch) {
          await readEntry(child, prefix ? `${prefix}/${entry.name}` : entry.name);
        }
      }
    }
  };
  for (const entry of entries) {
    if (entry) await readEntry(entry, '');
  }
  return out;
}
