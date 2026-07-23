import type Graph from 'graphology';

export type AtlasMode = 'radial' | 'tree';
export type AtlasPoint = { x: number; y: number };
export type AtlasNodeKind = 'root' | 'section' | 'doc';

export type AtlasNode = {
  id: string;
  kind: AtlasNodeKind;
  title: string;
  subtitle: string;
  kicker: string;
  sub: string | null;
  entityType: string;
  degree: number;
  depth: number;
  halfWidth: number;
};

export type AtlasEdge = {
  source: string;
  target: string;
  kind: string;
  topology: string;
  tree: boolean;
};

export type AtlasLayout = {
  root: string | null;
  nodes: AtlasNode[];
  byId: Map<string, AtlasNode>;
  edges: AtlasEdge[];
  positions: Record<AtlasMode, Map<string, AtlasPoint>>;
  bounds: Record<AtlasMode, { minX: number; maxX: number; minY: number; maxY: number }>;
};

function labelOf(graph: Graph, key: string): string {
  return String(graph.getNodeAttribute(key, 'displayLabel') ?? graph.getNodeAttribute(key, 'label') ?? key);
}

function sorted(graph: Graph, keys: Iterable<string>): string[] {
  return [...keys].sort((left, right) => labelOf(graph, left).localeCompare(labelOf(graph, right)) || left.localeCompare(right));
}

function boundsFor(nodes: readonly AtlasNode[], positions: Map<string, AtlasPoint>): AtlasLayout['bounds']['tree'] {
  if (!nodes.length) return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  return nodes.reduce(
    (bounds, node) => {
      const point = positions.get(node.id) ?? { x: 0, y: 0 };
      return {
        minX: Math.min(bounds.minX, point.x - node.halfWidth),
        maxX: Math.max(bounds.maxX, point.x + node.halfWidth),
        minY: Math.min(bounds.minY, point.y - 42),
        maxY: Math.max(bounds.maxY, point.y + 42),
      };
    },
    { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity },
  );
}

function radialPositions(nodes: readonly AtlasNode[], children: Map<string, string[]>, root: string | null): Map<string, AtlasPoint> {
  const positions = new Map<string, AtlasPoint>();
  if (!root) return positions;
  const depth = new Map<string, number>([[root, 0]]);
  const order = [root];
  for (let index = 0; index < order.length; index += 1) {
    const current = order[index];
    for (const child of children.get(current) ?? []) {
      if (depth.has(child)) continue;
      depth.set(child, (depth.get(current) ?? 0) + 1);
      order.push(child);
    }
  }
  const leaves = new Map<string, number>();
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const id = order[index];
    const childNodes = children.get(id) ?? [];
    leaves.set(id, childNodes.length ? childNodes.reduce((sum, child) => sum + (leaves.get(child) ?? 1), 0) : 1);
  }
  const countAtDepth = new Map<number, number>();
  depth.forEach((level) => countAtDepth.set(level, (countAtDepth.get(level) ?? 0) + 1));
  const radius = [0];
  for (let level = 1; level <= Math.max(...depth.values(), 0); level += 1) {
    radius[level] = Math.max((radius[level - 1] ?? 0) + 360, ((countAtDepth.get(level) ?? 1) * 150) / (2 * Math.PI));
  }
  positions.set(root, { x: 0, y: 0 });
  const assign = (id: string, start: number, end: number): void => {
    const level = depth.get(id) ?? 0;
    if (id !== root) positions.set(id, { x: Math.cos((start + end) / 2) * (radius[level] ?? 360), y: Math.sin((start + end) / 2) * (radius[level] ?? 360) });
    const childNodes = children.get(id) ?? [];
    const total = childNodes.reduce((sum, child) => sum + (leaves.get(child) ?? 1), 0) || 1;
    let cursor = start;
    for (const child of childNodes) {
      const span = ((end - start) * (leaves.get(child) ?? 1)) / total;
      assign(child, cursor, cursor + span);
      cursor += span;
    }
  };
  assign(root, -Math.PI, Math.PI);
  const outer = (radius[Math.max(...depth.values(), 0)] ?? 360) + 360;
  nodes.filter((node) => !positions.has(node.id)).forEach((node, index, orphans) => {
    const angle = (index / Math.max(1, orphans.length)) * Math.PI * 2;
    positions.set(node.id, { x: Math.cos(angle) * outer, y: Math.sin(angle) * outer });
  });
  return positions;
}

export function buildAtlasLayout(graph: Graph): AtlasLayout {
  const nodes = graph.nodes();
  const hierarchyChildren = new Map<string, string[]>();
  const allNeighbors = new Map<string, Set<string>>();
  const treeEdges = new Set<string>();
  const edgeRows: Array<{ source: string; target: string; kind: string; topology: string }> = [];

  graph.forEachNode((key) => allNeighbors.set(key, new Set()));
  graph.forEachEdge((edge, attributes, source, target) => {
    const topology = String(attributes.topology ?? 'association');
    const kind = String(attributes.kind ?? 'related');
    edgeRows.push({ source, target, kind, topology });
    allNeighbors.get(source)?.add(target);
    allNeighbors.get(target)?.add(source);
    if (topology === 'hierarchy') {
      const children = hierarchyChildren.get(source) ?? [];
      children.push(target);
      hierarchyChildren.set(source, children);
    }
  });

  // A hierarchy is a FOREST, not a single tree: a topic taxonomy has one root
  // per family, and a docs atlas has one. Seeding the walk with every root
  // keeps each family its own subtree — collapsing them under one arbitrary
  // root is what produced the degenerate single column.
  const hierarchyParentOf = new Map<string, string>();
  hierarchyChildren.forEach((kids, ancestor) => {
    for (const kid of kids) if (!hierarchyParentOf.has(kid)) hierarchyParentOf.set(kid, ancestor);
  });
  const hierarchyRoots = sorted(
    graph,
    nodes.filter((key) => !hierarchyParentOf.has(key) && (hierarchyChildren.get(key)?.length ?? 0) > 0),
  );
  const requestedRoot = graph.getAttribute('worldViewRoot');
  const root = typeof requestedRoot === 'string' && graph.hasNode(requestedRoot)
    ? requestedRoot
    : hierarchyRoots[0] ?? nodes[0] ?? null;

  const depth = new Map<string, number>();
  const parent = new Map<string, string>();
  const seeds = hierarchyRoots.length ? [...hierarchyRoots] : root ? [root] : [];
  if (root && !depth.has(root) && !seeds.includes(root)) seeds.unshift(root);
  const queue = [...seeds];
  for (const seed of seeds) depth.set(seed, 0);
  while (queue.length) {
    const current = queue.shift()!;
    for (const child of sorted(graph, hierarchyChildren.get(current) ?? [])) {
      if (depth.has(child)) continue;
      depth.set(child, (depth.get(current) ?? 0) + 1);
      parent.set(child, current);
      treeEdges.add(`${current}|${child}`);
      queue.push(child);
    }
  }
  // Nodes carried only by association edges (a doc bound to a topic, an
  // artifact linked to a deployment) hang off their deepest known neighbor
  // rather than all piling onto the root.
  for (const key of sorted(graph, nodes)) {
    if (depth.has(key)) continue;
    let anchor: string | null = null;
    let anchorDepth = -1;
    for (const neighbor of allNeighbors.get(key) ?? []) {
      const neighborDepth = depth.get(neighbor);
      if (neighborDepth !== undefined && neighborDepth > anchorDepth) {
        anchorDepth = neighborDepth;
        anchor = neighbor;
      }
    }
    depth.set(key, anchor ? anchorDepth + 1 : 0);
    if (anchor) parent.set(key, anchor);
  }

  const children = new Map<string, string[]>();
  parent.forEach((ancestor, child) => (children.get(ancestor) ?? children.set(ancestor, []).get(ancestor)!).push(child));
  const atlasNodes: AtlasNode[] = nodes.map((id) => {
    const childCount = children.get(id)?.length ?? 0;
    const kind: AtlasNodeKind = id === root ? 'root' : childCount ? 'section' : 'doc';
    const title = labelOf(graph, id);
    return {
      id,
      kind,
      title,
      subtitle: String(graph.getNodeAttribute(id, 'entityType') ?? ''),
      kicker: id === root ? 'You' : String(graph.getNodeAttribute(id, 'entityType') ?? ''),
      sub: id === root ? null : String(graph.getNodeAttribute(id, 'role') ?? graph.getNodeAttribute(id, 'entityType') ?? ''),
      entityType: String(graph.getNodeAttribute(id, 'entityType') ?? ''),
      degree: graph.degree(id),
      depth: depth.get(id) ?? 0,
      halfWidth: kind === 'root' ? 130 : kind === 'section' ? 110 : 104,
    };
  });
  const byId = new Map(atlasNodes.map((node) => [node.id, node]));
  const edges = edgeRows.map((edge) => ({
    ...edge,
    tree: treeEdges.has(`${edge.source}|${edge.target}`) || treeEdges.has(`${edge.target}|${edge.source}`),
  }));

  const tree = new Map<string, AtlasPoint>();
  const rowOf = new Map<string, number>();
  let cursor = 0;
  const walk = (key: string): void => {
    if (rowOf.has(key)) return;
    rowOf.set(key, cursor);
    cursor += 1;
    for (const child of sorted(graph, children.get(key) ?? [])) walk(child);
  };
  for (const seed of seeds) walk(seed);
  for (const key of sorted(graph, nodes)) walk(key); // detached stragglers
  for (const node of atlasNodes) {
    tree.set(node.id, { x: node.depth * 330, y: (rowOf.get(node.id) ?? 0) * 104 });
  }
  const radial = radialPositions(atlasNodes, children, root);
  return {
    root,
    nodes: atlasNodes,
    byId,
    edges,
    positions: { tree, radial },
    bounds: { tree: boundsFor(atlasNodes, tree), radial: boundsFor(atlasNodes, radial) },
  };
}
