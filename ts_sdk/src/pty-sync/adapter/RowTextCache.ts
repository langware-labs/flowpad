/**
 * Per-row text cache keyed by a content-version counter.
 *
 * Decoding an xterm buffer row to a JS string (`line.translateToString`)
 * is expensive and shows up as the dominant CPU cost when several callers
 * scan the buffer in a tight loop (annotation gutter, anchor resolution,
 * validator). This cache turns repeat `getLineText(absRow)` calls within
 * a single buffer state into Map lookups.
 *
 * Invalidation is all-or-nothing: when `contentVersion` advances, every
 * entry is dropped on the next access. The owner (`PtySyncSession`) bumps
 * the version only on content-changing events (chunk processed, rebuilt,
 * disposed), not on segment-only changes.
 */
export class RowTextCache {
  private contentVersion = -1;
  private cache = new Map<number, string | null>();

  /**
   * Return the cached row text for the current `contentVersion`, computing
   * and storing it on miss. If `contentVersion` differs from the version
   * the cache was last keyed on, the entire cache is cleared first.
   */
  getOrCompute(
    absRow: number,
    contentVersion: number,
    compute: () => string | null,
  ): string | null {
    if (contentVersion !== this.contentVersion) {
      this.cache.clear();
      this.contentVersion = contentVersion;
    }
    const hit = this.cache.get(absRow);
    if (hit !== undefined) return hit;
    const v = compute();
    this.cache.set(absRow, v);
    return v;
  }

  clear(): void {
    this.cache.clear();
    this.contentVersion = -1;
  }

  /** Number of rows currently cached (for tests + observability). */
  size(): number {
    return this.cache.size;
  }
}
