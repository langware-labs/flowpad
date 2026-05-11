/**
 * Anchored markdown — shared types.
 *
 * The "anchor" model is intentionally narrow today (line-based) but has a seam
 * for future anchor types (ProseMirror positions, character offsets, etc.).
 * Each track depends only on `LineAnchorProvider.getRect(line)`; what produces
 * that rect (a data-line DOM walk vs. a live Milkdown coordsAtPos call) is the
 * provider's concern.
 */

export type Anchor = { line: number };

export interface AnchoredItem<T = unknown> {
  id: string;
  anchor: Anchor;
  data: T;
}

export interface LineRect {
  /** offsetTop of the anchored element, relative to the body container */
  top: number;
  /** offsetHeight of the anchored element */
  height: number;
}

export interface LineAnchorProvider {
  /** Returns the rect for the given source line, or null if the line has no rendered anchor. */
  getRect(line: number): LineRect | null;
  /** Subscribe to layout-change events (resize, font load, content change). Returns unsubscribe. */
  subscribe(cb: () => void): () => void;
}

export interface AnchoredTrack<T = unknown> {
  id: string;
  side: 'left' | 'right';
  /** Column width in px. */
  width: number;
  items: AnchoredItem<T>[];
  /** Render a single item; called for every visible marker. */
  renderItem: (item: AnchoredItem<T>) => React.ReactNode;
}
