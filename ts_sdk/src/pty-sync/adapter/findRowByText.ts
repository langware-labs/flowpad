import type { IXtermAdapter } from './XtermAdapter.js';

export interface FindRowOpts {
  /** absRow to start scanning at (clamped to current eviction). Default: eviction. */
  scanFrom?: number;
  /**
   * If true, also try `"❯ " + needle` for each needle (live-prompt prefix).
   * Default true. Tried before the bare needle.
   */
  withPromptPrefix?: boolean;
}

const PROMPT_PREFIX = '❯ ';

/**
 * Linear scan over the xterm buffer looking for the first row whose
 * text (after `trimStart`) starts with any of the candidate strings
 * derived from `needles`.
 *
 * Centralizes the loop that previously lived inline in
 * `use-annotation-gutter.ts:findTextRow` and
 * `PtySyncSession.buildSegmentsFromAnchors`. Two micro-optimizations vs
 * the prior code:
 *   - one `trimStart()` allocation per row (was once per needle×candidate)
 *   - flat candidate array, no nested needle loop or `.some()` closure
 *
 * Cache hits in the adapter (`RowTextCache`) make repeated calls within
 * the same content version cheap.
 */
export function findRowByText(
  adapter: IXtermAdapter,
  needles: readonly string[],
  opts: FindRowOpts = {},
): number | null {
  if (needles.length === 0) return null;

  const bufLen = adapter.getBufferLength();
  const eviction = adapter.getEvictionOffset();
  const startRow = Math.max(eviction, opts.scanFrom ?? 0);
  const endRow = eviction + bufLen;
  if (startRow >= endRow) return null;

  const withPrefix = opts.withPromptPrefix ?? true;
  const candidates: string[] = [];
  for (const n of needles) {
    if (!n) continue;
    if (withPrefix) candidates.push(PROMPT_PREFIX + n);
    candidates.push(n);
  }
  if (candidates.length === 0) return null;

  for (let absRow = startRow; absRow < endRow; absRow++) {
    const lineText = adapter.getLineText(absRow);
    if (!lineText) continue;
    const trimmed = lineText.trimStart();
    for (let i = 0; i < candidates.length; i++) {
      if (trimmed.startsWith(candidates[i])) return absRow;
    }
  }
  return null;
}
