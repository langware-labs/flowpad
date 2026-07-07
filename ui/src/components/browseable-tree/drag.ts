import type { BrowseableDragData } from './types';

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
