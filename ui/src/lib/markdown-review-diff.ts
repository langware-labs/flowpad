/**
 * Pure model for the Word-style markdown "review compare" — diff two markdown
 * versions into runs, then render them back to markdown with inline `<ins>`/`<del>`
 * marks (Word "All Markup"). Headless → unit-tested directly; the component just
 * renders the output through the app's react-markdown stack.
 *
 * Word-level granularity (jsdiff `diffWords`) matches the approved prototype.
 * Asset markdown bodies are HTML-free by project rule, so the only raw HTML in
 * the output is the `<ins>`/`<del>` we inject.
 */

import { diffWords } from 'diff';

export type ReviewPartType = 'eq' | 'ins' | 'del';
export type Decision = 'pending' | 'accepted' | 'rejected';

export interface ReviewPart {
  type: ReviewPartType;
  value: string;
  /** Stable id for changed runs (ins/del); null for unchanged text. */
  id: number | null;
}

/** Diff two markdown strings into ordered runs (eq / ins / del). */
export function buildReviewParts(oldMd: string, newMd: string): ReviewPart[] {
  let id = 0;
  return diffWords(oldMd, newMd).map((p) => ({
    type: p.added ? 'ins' : p.removed ? 'del' : 'eq',
    value: p.value,
    id: p.added || p.removed ? ++id : null,
  }));
}

/**
 * Render runs back to a markdown string. Changed runs are wrapped in
 * `<ins class="rev-N">` / `<del class="rev-N">` while pending; a per-change
 * `decision` (or `final: true` = preview everything accepted) resolves them:
 *   - insertion: accepted → keep text, rejected → drop
 *   - deletion:  accepted → drop text (confirm deletion), rejected → keep text
 */
export function annotate(
  parts: ReviewPart[],
  decisions: Record<number, Decision> = {},
  opts: { final?: boolean } = {},
): string {
  return parts
    .map((p) => {
      if (p.type === 'eq' || p.id == null) return p.value;
      const decided: Decision = opts.final ? 'accepted' : decisions[p.id] ?? 'pending';
      if (p.type === 'ins') {
        if (decided === 'accepted') return p.value;
        if (decided === 'rejected') return '';
        return `<ins class="rev-${p.id}">${p.value}</ins>`;
      }
      // del
      if (decided === 'accepted') return ''; // confirm deletion = remove text
      if (decided === 'rejected') return p.value; // keep text
      return `<del class="rev-${p.id}">${p.value}</del>`;
    })
    .join('');
}

/** Number of changes still awaiting a decision. */
export function countPending(parts: ReviewPart[], decisions: Record<number, Decision>): number {
  return parts.filter((p) => p.id != null && (decisions[p.id] ?? 'pending') === 'pending').length;
}

/** Total changed runs (ins + del). */
export function countChanges(parts: ReviewPart[]): number {
  return parts.filter((p) => p.id != null).length;
}
