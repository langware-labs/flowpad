import type { IXtermAdapter } from './adapter/XtermAdapter.js';
import { findRowByText } from './adapter/findRowByText.js';

const PROMPT_PREFIX = '❯ ';
const NEEDLE_SEPARATOR = '\x1f';

interface ResolverEntry {
  absRow: number;
  needleHash: string;
}

/**
 * Caches annotation → absolute-row resolution across renders.
 *
 * The naive approach re-scans the whole xterm buffer for every annotation
 * on every render, which dominated CPU in perf traces of the interactive
 * terminal. In practice the answer is stable for the lifetime of an
 * annotation: it only changes when the row scrolls out of the eviction
 * window or when the annotation's content text is edited.
 *
 * `resolve()` checks the cached row first — a single `getLineText` to
 * confirm the row still contains the expected needle — and only falls
 * back to a full scan when the row has moved or been evicted. With the
 * adapter's `RowTextCache`, the validation lookup is a Map hit.
 */
export class AnnotationRowResolver {
  private resolved = new Map<string, ResolverEntry>();

  /**
   * Resolve annotation `id` to an absolute buffer row.
   *
   * @param id          stable identifier (annotation.id)
   * @param needles     candidate strings to match, longest first
   * @param adapter     xterm adapter
   * @param scanFrom    minimum absRow to start scanning at on cache miss
   *                    (callers walking annotations in chronological order
   *                    should pass the previous resolved row + 1 to avoid
   *                    duplicate-text collisions)
   */
  resolve(
    id: string,
    needles: readonly string[],
    adapter: IXtermAdapter,
    scanFrom: number,
  ): number | null {
    if (needles.length === 0) return null;

    const needleHash = needles.join(NEEDLE_SEPARATOR);
    const eviction = adapter.getEvictionOffset();
    const cached = this.resolved.get(id);

    // Fast path: cached row still in buffer and still matches the needle.
    if (cached && cached.needleHash === needleHash && cached.absRow >= eviction) {
      if (rowMatchesAnyNeedle(adapter, cached.absRow, needles)) {
        return cached.absRow;
      }
      this.resolved.delete(id);
    }

    const absRow = findRowByText(adapter, needles, { scanFrom, withPromptPrefix: true });
    if (absRow !== null) {
      this.resolved.set(id, { absRow, needleHash });
    }
    return absRow;
  }

  /** Drop entries whose row fell below the current eviction floor. */
  pruneEvicted(evictionFloor: number): void {
    for (const [id, entry] of this.resolved) {
      if (entry.absRow < evictionFloor) this.resolved.delete(id);
    }
  }

  /** Clear all resolutions (call on session switch). */
  clear(): void {
    this.resolved.clear();
  }

  /** Number of cached resolutions (for tests + observability). */
  size(): number {
    return this.resolved.size;
  }
}

function rowMatchesAnyNeedle(
  adapter: IXtermAdapter,
  absRow: number,
  needles: readonly string[],
): boolean {
  const text = adapter.getLineText(absRow);
  if (!text) return false;
  const trimmed = text.trimStart();
  for (const n of needles) {
    if (!n) continue;
    if (trimmed.startsWith(PROMPT_PREFIX + n)) return true;
    if (trimmed.startsWith(n)) return true;
  }
  return false;
}
