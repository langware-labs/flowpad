/**
 * Re-attach pre-linter trace+analysis line numbers to current step bullets.
 *
 * Background: a markdown linter on the user's machine rewrites workflow
 * .md files by inserting blank lines between bullets — e.g. step bullets
 * that used to live on lines 11/12/13/14 are now on 13/15/17/19. The
 * trace JSONL + analysis JSONL on disk still reference the pre-rewrite
 * line numbers. Without a remap the runner shows every step as
 * "incomplete" because no trace event matches the current bullet line.
 *
 * Strategy: ordinal mapping. If every trace/analysis anchor line already
 * matches a current bullet line, return identity. Otherwise sort both
 * lists and pair them by index — anchor #0 → bullet #0, etc. This is
 * safe when the linter only shifted line numbers (preserving order).
 *
 * Bails out (returns identity) if:
 *   - all anchors already match bullets (no remap needed)
 *   - anchor count > bullet count (.md lost steps; can't remap safely)
 *   - the source has no step bullets yet (loading)
 */

export interface RemapInput {
  /** 1-indexed line numbers of step bullets in the current .md, ordered. */
  bulletLines: number[];
  /** Union of anchor lines seen in trace + analysis, ordered. */
  anchorLines: number[];
}

export type LineRemap = (originalLine: number) => number;

const identity: LineRemap = (line) => line;

export function buildLineRemap({ bulletLines, anchorLines }: RemapInput): LineRemap {
  if (bulletLines.length === 0 || anchorLines.length === 0) return identity;
  const bulletSet = new Set(bulletLines);
  // All anchors are already valid step bullets — nothing to do.
  if (anchorLines.every((l) => bulletSet.has(l))) return identity;
  // Can't safely remap if there are more anchors than current bullets.
  if (anchorLines.length > bulletLines.length) return identity;

  const sortedBullets = [...bulletLines].sort((a, b) => a - b);
  const sortedAnchors = [...anchorLines].sort((a, b) => a - b);

  const map = new Map<number, number>();
  for (let i = 0; i < sortedAnchors.length; i++) {
    map.set(sortedAnchors[i], sortedBullets[i]);
  }
  return (line: number) => map.get(line) ?? line;
}

/** Convenience: extract distinct line numbers from a list of records. */
export function distinctLines(records: { line?: number; anchor?: { line?: number } }[]): number[] {
  const out = new Set<number>();
  for (const r of records) {
    const line = r.line ?? r.anchor?.line;
    if (typeof line === 'number' && Number.isFinite(line)) out.add(line);
  }
  return [...out].sort((a, b) => a - b);
}
