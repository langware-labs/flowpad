/**
 * The `chain` action's payload → rows for the ChainTree.
 *
 * The hub gives hops (flat) and paths (entry→root id lists, in fallback order).
 * The tree is the union of the paths laid out depth-first: each hop appears
 * once per parent it hangs from, at the depth of that path. `isOnPath` marks
 * the hops on the FIRST path — the one the router tries first — and `health`
 * folds enabled/credential/breaker into one word the row can colour by.
 *
 * **Pure.** Unit-tested against a hand-built chain payload.
 */
import type { LLMChain, LLMChainHop } from '@sdk';

import { endpointTypeId } from './llm-endpoints-pointer';

export type HopHealth = 'ok' | 'disabled' | 'no_credential' | 'breaker_open' | 'missing';

export interface ChainTreeNode {
  id: string;
  name: string;
  depth: number;
  hop: LLMChainHop | null;
  /** On the first (preferred) fallback path. */
  isOnPath: boolean;
  /** Which fallback paths (indices into `chain.paths`) run through this row. */
  pathIndexes: number[];
  isRoot: boolean;
  /** The router's sticky root for the caller. */
  isSticky: boolean;
  health: HopHealth;
  /** Position within its parent's children — the fallback order. */
  order: number;
  /** Stable key: the ancestor id path, so a hop reachable two ways gets two rows. */
  key: string;
}

export function hopHealth(hop: LLMChainHop | null | undefined): HopHealth {
  if (!hop) return 'missing';
  if (!hop.enabled) return 'disabled';
  if (hop.breaker?.state === 'open') return 'breaker_open';
  if (hop.is_root && !hop.has_credential) return 'no_credential';
  return 'ok';
}

interface Trie {
  id: string;
  children: Map<string, Trie>;
  childOrder: string[];
  pathIndexes: number[];
}

export function buildChainTree(chain: LLMChain | null | undefined): ChainTreeNode[] {
  if (!chain) return [];
  const hops = new Map<string, LLMChainHop>(chain.hops.map((h) => [h.id, h]));
  const paths = chain.paths.length ? chain.paths : [[chain.entry.id]];

  // Merge the paths into a trie keyed by ancestor path, keeping first-seen child
  // order (= fallback order, because the hub lists paths in that order).
  const root: Trie = { id: chain.entry.id, children: new Map(), childOrder: [], pathIndexes: [] };
  paths.forEach((path, pathIndex) => {
    let node = root;
    node.pathIndexes.push(pathIndex);
    for (const id of path.slice(1)) {
      let child = node.children.get(id);
      if (!child) {
        child = { id, children: new Map(), childOrder: [], pathIndexes: [] };
        node.children.set(id, child);
        node.childOrder.push(id);
      }
      child.pathIndexes.push(pathIndex);
      node = child;
    }
  });

  const missing = new Set(chain.missing_sources ?? []);
  const out: ChainTreeNode[] = [];
  const walk = (node: Trie, depth: number, order: number, keyPrefix: string) => {
    const hop = hops.get(node.id) ?? null;
    const key = keyPrefix ? `${keyPrefix}/${node.id}` : node.id;
    out.push({
      id: node.id,
      name: hop?.name ?? (missing.has(node.id) ? node.id : node.id),
      depth,
      hop,
      isOnPath: node.pathIndexes.includes(0),
      pathIndexes: [...node.pathIndexes],
      isRoot: hop ? hop.is_root : node.children.size === 0,
      isSticky: chain.sticky_root_for_me === node.id,
      health: hopHealth(hop),
      order,
      key,
    });
    node.childOrder.forEach((childId, i) => walk(node.children.get(childId) as Trie, depth + 1, i, key));
  };
  walk(root, 0, 0, '');

  // Sources the hub could not resolve hang off the entry as `missing` rows so
  // the user sees the hole rather than a silently shorter fan-out.
  for (const id of chain.missing_sources ?? []) {
    if (out.some((n) => n.id === id)) continue;
    out.push({
      id,
      name: id,
      depth: 1,
      hop: null,
      isOnPath: false,
      pathIndexes: [],
      isRoot: false,
      isSticky: false,
      health: 'missing',
      order: out.length,
      key: `${chain.entry.id}/${id}`,
    });
  }
  return out;
}

/**
 * The endpoints that name `id` as a source, in list order — the downward half
 * of the graph. `sources` hold typeids, `id` is the bare uuid.
 */
export function consumersOf<T extends { id: string; sources: string[] }>(id: string, all: readonly T[]): T[] {
  const tid = endpointTypeId(id);
  return all.filter((e) => e.sources.includes(tid));
}

export interface ConsumerRow<T> {
  endpoint: T;
  depth: number;
}

/**
 * Consumers of `id`, then their consumers, depth-first (an endpoint reached two
 * ways is listed once, at its first depth). Bounded so a stale cycle cannot loop.
 */
export function consumerRows<T extends { id: string; sources: string[] }>(
  id: string,
  all: readonly T[],
  maxDepth = 6,
): ConsumerRow<T>[] {
  const rows: ConsumerRow<T>[] = [];
  const seen = new Set<string>([id]);
  const walk = (parent: string, depth: number) => {
    if (depth > maxDepth) return;
    for (const child of consumersOf(parent, all)) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      rows.push({ endpoint: child, depth });
      walk(child.id, depth + 1);
    }
  };
  walk(id, 0);
  return rows;
}
