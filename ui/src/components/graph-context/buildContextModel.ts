import { APIEntity, GraphContext, TypeId, dataManager, isTypeId, type AnyEntity } from '@sdk';

/** Upper bound on nodes so a deeply-connected context can't blow up the canvas. */
export const MAX_NODES = 250;

export type ContextEdgeKind = 'member' | 'shared' | 'private';

export interface ContextNode {
  /** Typeid string ("<type>-<id>"); the root uses the GraphContext typeid. */
  key: string;
  type: string;
  id: string;
  label: string;
  /** Hops from the root (0 = root). */
  depth: number;
  /** Tree parent (first edge that introduced the node); null for the root. */
  parentKey: string | null;
  isRoot: boolean;
  /** Whether the backing entity resolved (false ⇒ raw-typeid placeholder). */
  resolved: boolean;
}

export interface ContextEdge {
  source: string;
  target: string;
  kind: ContextEdgeKind;
  /** True when the edge links to an already-placed node (not the tree edge). */
  cross: boolean;
}

export interface ContextModel {
  nodes: ContextNode[];
  edges: ContextEdge[];
  truncated: boolean;
}

type FrontierItem = { parentKey: string; tidStr: string; kind: ContextEdgeKind };

/**
 * BFS a GraphContext into a plain node/edge model for the bespoke canvas:
 * depth 0 = the root, depth 1 = its frozen `context_typeids` (kind `member`),
 * deeper hops follow each fetched entity's `sharedContextEntities` (`shared`) ∪
 * `privateContextEntities` (`private`). Capped at MAX_NODES. Unresolved typeids
 * still appear as raw-typeid nodes (not expanded).
 */
export async function buildContextModel(
  root: GraphContext,
  distance: number,
): Promise<ContextModel> {
  const nodes = new Map<string, ContextNode>();
  const edges: ContextEdge[] = [];
  let truncated = false;

  const rootKey = root.typeId.toString();
  nodes.set(rootKey, {
    key: rootKey,
    type: GraphContext.type,
    id: root.id,
    label: root.displayName || 'Context',
    depth: 0,
    parentKey: null,
    isRoot: true,
    resolved: true,
  });

  let frontier: FrontierItem[] = (root.context_typeids ?? [])
    .filter((t) => isTypeId(t))
    .map((tidStr) => ({ parentKey: rootKey, tidStr, kind: 'member' as ContextEdgeKind }));

  let depth = 1;
  while (frontier.length > 0 && depth <= distance) {
    // Dedupe identical parent→child relations within this level.
    const seen = new Set<string>();
    const level = frontier.filter((f) => {
      const k = `${f.parentKey}|${f.tidStr}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    const resolvedLevel = await Promise.all(
      level.map(async (f) => {
        const tid = new TypeId(f.tidStr);
        let entity: AnyEntity | null = null;
        try {
          entity = await dataManager.getByTypeId(tid);
        } catch {
          entity = null;
        }
        return { ...f, entity, tid };
      }),
    );

    const next: FrontierItem[] = [];
    for (const r of resolvedLevel) {
      const key = r.tidStr;
      const exists = nodes.has(key);
      if (!exists) {
        if (nodes.size >= MAX_NODES) {
          truncated = true;
          continue;
        }
        nodes.set(key, {
          key,
          type: r.tid.type,
          id: r.tid.id,
          label: r.entity?.displayName || `${r.tid.type}-${r.tid.id.slice(0, 6)}`,
          depth,
          parentKey: r.parentKey,
          isRoot: false,
          resolved: !!r.entity,
        });
      }
      edges.push({ source: r.parentKey, target: key, kind: r.kind, cross: exists });

      if (depth < distance && r.entity) {
        for (const t of r.entity.sharedContextEntities ?? []) {
          next.push({ parentKey: key, tidStr: t.toString(), kind: 'shared' });
        }
        for (const t of r.entity.privateContextEntities ?? []) {
          next.push({ parentKey: key, tidStr: t.toString(), kind: 'private' });
        }
      }
    }

    frontier = next;
    depth += 1;
  }

  return { nodes: [...nodes.values()], edges, truncated };
}
