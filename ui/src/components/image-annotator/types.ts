/** Shared types + constants for the image annotator. */

export const COLORS = ['#ef4444', '#eab308', '#22c55e', '#3b82f6', '#111827', '#ffffff'] as const;

export type Tool = 'pen' | 'arrow' | 'text';

export interface Point {
  x: number;
  y: number;
}

/** A pen or arrow stroke, in natural-canvas coordinates. */
export interface Stroke {
  tool: 'pen' | 'arrow';
  color: string;
  width: number;
  points: Point[];
}

/** A text annotation (DOM overlay until flattened), in natural-canvas coordinates. */
export interface TextBox {
  id: number;
  x: number;
  y: number;
  color: string;
  fontPx: number;
  text: string;
}

/** Force a `.png` extension — a re-encoded JPEG/GIF must not keep a misleading name. */
export function toPngName(name: string): string {
  const base = name.replace(/\.[^./\\]+$/, '');
  return `${base || 'image'}.png`;
}
