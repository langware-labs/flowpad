/**
 * Pure tab-ordering algebra — the frontend port of the backend contract
 * (`flow_sdk/builtin/tab_order.py`). These MUST stay byte-for-byte equivalent:
 * `ui/tests/unit/tab-order.test.ts` and `tests/unit/test_tab_order.py` run the
 * same matrix (`ui/tests/fixtures/tab-order-matrix.json`) and assert identical
 * results — that is the front/back parity proof.
 *
 * The backend is the source of truth: these run only to PREDICT the order during
 * a drag (optimistic drop placement) before the backend's canonical list lands.
 * The frontend never decides order on its own.
 */

/** Move `reorderId` into the drop-gap (after `afterId` / before `beforeId`)
 *  within the global `order`. Null/absent anchors fall through to append. */
export function computeReorder(
  order: string[],
  reorderId: string,
  afterId: string | null,
  beforeId: string | null,
): string[] {
  const ids = order.filter((i) => i !== reorderId);
  let idx: number;
  if (afterId != null && ids.includes(afterId)) {
    idx = ids.indexOf(afterId) + 1;
  } else if (beforeId != null && ids.includes(beforeId)) {
    idx = ids.indexOf(beforeId);
  } else {
    idx = ids.length;
  }
  ids.splice(idx, 0, reorderId);
  return ids;
}

/** Place a brand-new `newId` immediately after `afterId` (the opener); append
 *  when there is no opener. A `newId` already present (reopen) keeps its slot. */
export function computeInsertNew(order: string[], newId: string, afterId: string | null): string[] {
  if (order.includes(newId)) return [...order];
  if (afterId != null && order.includes(afterId)) {
    const idx = order.indexOf(afterId) + 1;
    return [...order.slice(0, idx), newId, ...order.slice(idx)];
  }
  return [...order, newId];
}

/** Drop `closeId`; the survivors keep their relative order. */
export function computeClose(order: string[], closeId: string): string[] {
  return order.filter((i) => i !== closeId);
}

/** Ids whose contiguous index changed — the rows the backend would persist.
 *  Empty ⇒ no write (a no-op drop). */
export function changedIds(oldOrder: string[], newOrder: string[]): Set<string> {
  const oldIdx = new Map(oldOrder.map((id, i) => [id, i]));
  return new Set(newOrder.filter((id, i) => oldIdx.get(id) !== i));
}

/** The project view: global order filtered to tabs in `projectId` plus all
 *  projectless tabs (project == null), preserving global order. */
export function filterForProject(
  order: string[],
  projectOf: Record<string, string | null>,
  projectId: string | null,
): string[] {
  return order.filter((id) => projectOf[id] === projectId || projectOf[id] == null);
}
