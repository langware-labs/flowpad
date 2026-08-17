/**
 * Pure tab-ordering algebra. The backend remains the source of truth; these
 * functions only predict its result for optimistic UI updates.
 *
 * Keep this implementation in parity with `flow_sdk/builtin/tab_order.py`.
 */

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

export function computeInsertNew(order: string[], newId: string, afterId: string | null): string[] {
  if (order.includes(newId)) return [...order];
  if (afterId != null && order.includes(afterId)) {
    const idx = order.indexOf(afterId) + 1;
    return [...order.slice(0, idx), newId, ...order.slice(idx)];
  }
  return [...order, newId];
}

export function computeClose(order: string[], closeId: string): string[] {
  return order.filter((i) => i !== closeId);
}

export function changedIds(oldOrder: string[], newOrder: string[]): Set<string> {
  const oldIdx = new Map(oldOrder.map((id, i) => [id, i]));
  return new Set(newOrder.filter((id, i) => oldIdx.get(id) !== i));
}

export function filterForProject(
  order: string[],
  projectOf: Record<string, string | null>,
  projectId: string | null,
): string[] {
  return order.filter((id) => (projectOf[id] ?? null) === projectId);
}
