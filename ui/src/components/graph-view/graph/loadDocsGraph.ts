// Loads the docs knowledge graph from the native LLMIndexer scan endpoint and
// builds a graphology Graph the shared GraphEngine can render unchanged.
//
// Unlike loadDepGraph (random + force-atlas2), docs are a tree, so positions are
// assigned with a left→right hierarchical layout derived from the `child` edges.
// `context_shared` edges are the [[wiki]] cross-links drawn on top of the spine.

import Graph from 'graphology';
import { iconDataUriForType } from '../icons/iconToDataUri';
import { hexForType } from '../ui/typeColors';
import { paletteForTheme, type EdgeKind, type Theme } from './themeColors';

type DocsNode = { type: string; id: string; label: string | null; is_ghost: boolean; key: string };
type DocsEdge = { from: { type: string; id: string }; to: { type: string; id: string }; kind: EdgeKind };
type DocsGraphData = { nodes: DocsNode[]; edges: DocsEdge[]; counts: { nodes: number; edges: number } };
type Envelope = { status: string; data?: DocsGraphData };

const X_SPACING = 240; // horizontal gap between tree depths
const Y_SPACING = 64; // vertical gap between sibling leaves

export async function loadDocsGraph(root: string, opts: { theme?: Theme } = {}): Promise<Graph> {
  const palette = paletteForTheme(opts.theme ?? 'dark');

  const res = await fetch(`/api/v1/docs-graph?root=${encodeURIComponent(root)}`);
  if (!res.ok) throw new Error(`docs-graph fetch failed: ${res.status}`);
  const env = (await res.json()) as Envelope | null;
  const nodes = Array.isArray(env?.data?.nodes) ? env!.data!.nodes : [];
  const edges = Array.isArray(env?.data?.edges) ? env!.data!.edges : [];

  // Build the parent→children adjacency from the tree spine (child edges).
  const children = new Map<string, string[]>();
  const hasParent = new Set<string>();
  for (const e of edges) {
    if (e.kind !== 'child') continue;
    const parent = `${e.from.type}-${e.from.id}`;
    const child = `${e.to.type}-${e.to.id}`;
    let arr = children.get(parent);
    if (!arr) {
      arr = [];
      children.set(parent, arr);
    }
    arr.push(child);
    hasParent.add(child);
  }

  // Tidy-ish layout: leaves get successive rows; an internal node centers on its
  // children. x = depth, y = row.
  // The scan tree is acyclic (filesystem parent→child), so place() recurses once
  // per node. x = depth; leaves take successive rows, parents center on theirs.
  const pos = new Map<string, { x: number; y: number }>();
  let nextRow = 0;
  const place = (key: string, depth: number): number => {
    const kids = children.get(key) ?? [];
    let y: number;
    if (kids.length === 0) {
      y = nextRow++;
    } else {
      const ys = kids.map((k) => place(k, depth + 1));
      y = (Math.min(...ys) + Math.max(...ys)) / 2;
    }
    pos.set(key, { x: depth, y });
    return y;
  };
  for (const n of nodes) if (!hasParent.has(n.key)) place(n.key, 0);

  const graph = new Graph({ type: 'undirected', multi: false });
  for (const n of nodes) {
    const p = pos.get(n.key) ?? { x: 0, y: nextRow++ };
    graph.addNode(n.key, {
      label: n.label || `${n.type}-${n.id.slice(0, 6)}`,
      entityType: n.type,
      entityId: n.id,
      isGhost: n.is_ghost,
      x: p.x * X_SPACING,
      y: p.y * Y_SPACING,
      size: n.type === 'markdown_index' ? 11 : 8,
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
      color: palette.edgeKindColor[e.kind] ?? palette.defaultEdgeColor,
      size: e.kind === 'child' ? 0.8 : 0.5,
      curvature: e.kind === 'child' ? 0 : 0.25,
      kind: e.kind,
    });
  }

  return graph;
}
