import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';
import { initIconRegistry } from '../icons/iconRegistry';
import { iconDataUriForType } from '../icons/iconToDataUri';
import { hexForType } from '../ui/typeColors';

type DepGraphNode = {
  type: string;
  id: string;
  label: string | null;
  is_ghost: boolean;
  key: string;
};
type DepGraphEdge = {
  from: { type: string; id: string };
  to: { type: string; id: string };
  kind: 'child' | 'context_shared' | 'context_private' | 'parent';
};
type DepGraphResponse = {
  nodes: DepGraphNode[];
  edges: DepGraphEdge[];
  counts: { nodes: number; edges: number };
};

export type LoadOptions = {
  apiUrl?: string;
  dropOrphans?: boolean;
};

export const EDGE_KIND_COLOR: Record<DepGraphEdge['kind'], string> = {
  child: 'rgba(99, 102, 241, 0.55)',
  context_shared: 'rgba(16, 185, 129, 0.65)',
  context_private: 'rgba(245, 158, 11, 0.75)',
  parent: 'rgba(167, 139, 250, 0.55)',
};

export async function loadDepGraph(opts: LoadOptions = {}): Promise<Graph> {
  const apiUrl = opts.apiUrl ?? '/api/v1/dep_graph';
  const dropOrphans = opts.dropOrphans ?? true;

  const [, res] = await Promise.all([initIconRegistry(), fetch(apiUrl)]);
  if (!res.ok) throw new Error(`dep_graph fetch failed: ${res.status}`);
  const data = (await res.json()) as Partial<DepGraphResponse> | null;

  const graph = new Graph({ type: 'undirected', multi: false });
  const nodes = Array.isArray(data?.nodes) ? data.nodes : [];
  const edges = Array.isArray(data?.edges) ? data.edges : [];

  const connected = new Set<string>();
  for (const e of edges) {
    connected.add(`${e.from.type}-${e.from.id}`);
    connected.add(`${e.to.type}-${e.to.id}`);
  }

  for (const n of nodes) {
    if (dropOrphans && !connected.has(n.key)) continue;
    const angle = Math.random() * Math.PI * 2;
    const radius = Math.random() * 200;
    graph.addNode(n.key, {
      label: n.label || `${n.type}-${n.id.slice(0, 6)}`,
      entityType: n.type,
      entityId: n.id,
      isGhost: n.is_ghost,
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      size: 8,
      color: hexForType(n.type),
      community: 0,
      type: 'image',
      image: iconDataUriForType(n.type),
    });
  }

  for (const [i, e] of edges.entries()) {
    const src = `${e.from.type}-${e.from.id}`;
    const tgt = `${e.to.type}-${e.to.id}`;
    if (!graph.hasNode(src) || !graph.hasNode(tgt) || src === tgt) continue;
    if (graph.hasEdge(src, tgt)) continue;
    graph.addUndirectedEdgeWithKey(`e-${i}`, src, tgt, {
      color: EDGE_KIND_COLOR[e.kind] ?? 'rgba(255,255,255,0.18)',
      size: 0.6,
      curvature: 0.18,
      kind: e.kind,
    });
  }

  louvain.assign(graph);

  graph.forEachNode((node) => {
    const degree = graph.degree(node);
    graph.mergeNodeAttributes(node, {
      size: 7 + Math.min(14, Math.sqrt(degree) * 2),
    });
  });

  return graph;
}
