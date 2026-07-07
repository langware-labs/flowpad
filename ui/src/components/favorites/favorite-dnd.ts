/**
 * Native HTML5 drag-and-drop contract for MiniDesktop favorite tiles.
 * The payload is just the bookmark id under a custom MIME so foreign drags
 * are ignored. Note: `dragover` cannot read the payload on most browsers —
 * gate droppability on `e.dataTransfer.types.includes(FAVORITE_DRAG_MIME)`
 * and read the id only in `onDrop`. (Same shape as BrowseableTree's
 * `application/x-flowpad-browseable` convention.)
 */
export const FAVORITE_DRAG_MIME = 'application/x-flowpad-favorite';

export function favoriteDragActive(e: React.DragEvent): boolean {
  return e.dataTransfer.types.includes(FAVORITE_DRAG_MIME);
}

export function readFavoriteDragId(e: React.DragEvent): string | null {
  return e.dataTransfer.getData(FAVORITE_DRAG_MIME) || null;
}
