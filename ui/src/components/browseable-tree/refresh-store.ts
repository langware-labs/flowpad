/**
 * Module-level refresh bus for BrowseableTree nodes.
 *
 * Adapters live outside React and don't have access to the tree's imperative
 * state. When a tree-relevant side effect happens (e.g. delete from a row's
 * hover toolbar) the caller fires `refreshNode(nodeId)`. The mounted
 * `<BrowseableTree>` is subscribed and re-fetches that node's children — the
 * row disappears (or the tree updates) without resetting expansion state.
 *
 * `nodeId` must match the id the adapter assigned to the node whose children
 * should be re-fetched (typically a root id).
 */

const listeners = new Set<(nodeId: string) => void>();

export function refreshNode(nodeId: string): void {
  for (const fn of listeners) fn(nodeId);
}

export function subscribeRefresh(fn: (nodeId: string) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
