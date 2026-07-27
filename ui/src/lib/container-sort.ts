/**
 * Container sort for the favorites desktop — the frontend half of a
 * dual-implemented pure function. MUST stay byte-for-byte equivalent to
 * `sort_container` in `flow_sdk/builtin/bookmark.py`; parity is proven by the
 * shared matrix `ui/tests/fixtures/container-sort-matrix.json`, consumed by
 * both `ui/tests/unit/container-sort.test.ts` and
 * `tests/unit/test_container_sort.py`.
 *
 * Semantics: stamped rows (order >= 1) ascending first (id ascending as the
 * tiebreak), unstamped rows (order 0/unset) at the END, newest first among
 * themselves — so legacy containers keep newest-first until the first drag
 * and webhook-created rows land at the end of stamped containers.
 */
export interface ContainerSortable {
  id?: string;
  order?: number;
  created_date?: string | Date | null;
}

// Plain code-unit comparison — NOT localeCompare — to match Python's str
// ordering byte-for-byte.
function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sortContainer<T extends ContainerSortable>(siblings: T[]): T[] {
  const stamped = siblings
    .filter((b) => (b.order ?? 0) > 0)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || cmpStr(String(a.id), String(b.id)));
  const unstamped = siblings
    .filter((b) => !(b.order ?? 0))
    .sort((a, b) => cmpStr(String(b.created_date ?? ''), String(a.created_date ?? '')));
  return [...stamped, ...unstamped];
}
