import type Graph from 'graphology';

const HIERARCHY = 'hierarchy';
const MINIMUM_ARC = 110;
const MINIMUM_RING_GAP = 280;

type Proposal = {
  node: string;
  parent: string;
  priority: number;
};

type NodeCompare = (left: string, right: string) => number;

export type CircleForestLayoutResult = {
  root: string | null;
  roots: readonly string[];
  /** Visual ring depth. The selected hierarchy root is always depth zero. */
  depth: ReadonlyMap<string, number>;
};

function nodeComparator(graph: Graph): NodeCompare {
  const order = new Map<string, string>();
  graph.forEachNode((node, attributes) => {
    order.set(node, `${String(attributes.entityType ?? '')}:${String(attributes.label ?? '')}:${node}`);
  });
  return (left, right) => (order.get(left) ?? left).localeCompare(order.get(right) ?? right);
}

function weakComponents(graph: Graph, compareNodes: NodeCompare): string[][] {
  const remaining = new Set(graph.nodes());
  const components: string[][] = [];
  const orderedNodes = graph.nodes().sort(compareNodes);

  for (const start of orderedNodes) {
    if (!remaining.delete(start)) continue;
    const component: string[] = [];
    const pending = [start];
    while (pending.length > 0) {
      const current = pending.pop()!;
      component.push(current);
      const neighbors = graph.neighbors(current).sort(compareNodes);
      for (let index = neighbors.length - 1; index >= 0; index -= 1) {
        const neighbor = neighbors[index];
        if (!remaining.delete(neighbor)) continue;
        pending.push(neighbor);
      }
    }
    component.sort(compareNodes);
    components.push(component);
  }

  return components.sort((left, right) => right.length - left.length || compareNodes(left[0], right[0]));
}

function hierarchyRoots(
  graph: Graph,
  component: readonly string[],
  compareNodes: NodeCompare,
  requestedRoot?: string,
): string[] {
  if (requestedRoot && component.includes(requestedRoot)) return [requestedRoot];

  const componentNodes = new Set(component);
  const incoming = new Map(component.map((node) => [node, 0]));
  let hasHierarchy = false;
  for (const target of component) {
    graph.forEachInEdge(target, (_edge, attributes, source) => {
      if (attributes.topology !== HIERARCHY || source === target || !componentNodes.has(source)) return;
      hasHierarchy = true;
      incoming.set(target, (incoming.get(target) ?? 0) + 1);
    });
  }

  if (hasHierarchy) {
    const roots = component.filter((node) => (incoming.get(node) ?? 0) === 0).sort(compareNodes);
    if (roots.length > 0) return roots;
  }
  return [component[0]];
}

function proposalIsBetter(compareNodes: NodeCompare, candidate: Proposal, current: Proposal | undefined): boolean {
  if (!current || candidate.priority !== current.priority) {
    return !current || candidate.priority < current.priority;
  }
  return compareNodes(candidate.parent, current.parent) < 0;
}

/**
 * Build one deterministic breadth-first tree per semantic hierarchy root.
 * Proposals are resolved across the whole frontier, so an association from an
 * earlier node cannot steal a child from a later hierarchy parent.
 */
function traverseComponent(
  graph: Graph,
  component: readonly string[],
  roots: readonly string[],
  localDepth: Map<string, number>,
  treeRoot: Map<string, string>,
  children: Map<string, string[]>,
  compareNodes: NodeCompare,
): void {
  const componentNodes = new Set(component);
  const visited = new Set(roots);
  let frontier = [...roots].sort(compareNodes);
  for (const root of frontier) {
    localDepth.set(root, 0);
    treeRoot.set(root, root);
  }

  while (frontier.length > 0) {
    const proposals = new Map<string, Proposal>();
    for (const current of frontier) {
      graph.forEachEdge(current, (_edge, attributes, source, target) => {
        const node = source === current ? target : source;
        if (!componentNodes.has(node) || visited.has(node)) return;
        const priority = attributes.topology === HIERARCHY ? (source === current ? 0 : 1) : 2;
        const proposal = { node, parent: current, priority };
        if (proposalIsBetter(compareNodes, proposal, proposals.get(node))) proposals.set(node, proposal);
      });
    }

    const next: string[] = [];
    const ordered = [...proposals.values()].sort(
      (left, right) =>
        left.priority - right.priority ||
        compareNodes(left.parent, right.parent) ||
        compareNodes(left.node, right.node),
    );
    for (const proposal of ordered) {
      if (visited.has(proposal.node)) continue;
      visited.add(proposal.node);
      localDepth.set(proposal.node, (localDepth.get(proposal.parent) ?? 0) + 1);
      treeRoot.set(proposal.node, treeRoot.get(proposal.parent) ?? proposal.parent);
      const siblings = children.get(proposal.parent) ?? [];
      siblings.push(proposal.node);
      children.set(proposal.parent, siblings);
      next.push(proposal.node);
    }
    frontier = next;
  }
}

function ringArc(graph: Graph, nodes: readonly string[]): number {
  let widestLabel = 0;
  for (const node of nodes) {
    const attributes = graph.getNodeAttributes(node);
    const label = String(attributes.displayLabel ?? attributes.label ?? '');
    widestLabel = Math.max(widestLabel, Math.min(180, Array.from(label).length * 7));
  }
  return Math.max(MINIMUM_ARC, widestLabel + 36);
}

/**
 * Lay a graph out as one readable radial forest.
 *
 * An explicit WorldView root remains central. Without one, the hierarchy root
 * of the largest connected component becomes central. Every other hierarchy
 * root starts a breadth-first tree on the next adaptive ring; no disconnected
 * component is flattened or loses its parent/child structure.
 */
export function applyCircleForestLayout(graph: Graph): CircleForestLayoutResult {
  if (graph.order === 0) return { root: null, roots: [], depth: new Map() };

  const compareNodes = nodeComparator(graph);
  const requested = graph.getAttribute('worldViewRoot');
  const requestedRoot = typeof requested === 'string' && graph.hasNode(requested) ? requested : undefined;
  const components = weakComponents(graph, compareNodes);
  if (requestedRoot) {
    const requestedIndex = components.findIndex((component) => component.includes(requestedRoot));
    if (requestedIndex > 0) components.unshift(...components.splice(requestedIndex, 1));
  }

  const rootsByComponent = components.map((component, index) =>
    hierarchyRoots(graph, component, compareNodes, index === 0 ? requestedRoot : undefined),
  );
  const primaryRoot = requestedRoot ?? rootsByComponent[0][0];
  const roots = [primaryRoot, ...rootsByComponent.flat().filter((root) => root !== primaryRoot)];

  const localDepth = new Map<string, number>();
  const treeRoot = new Map<string, string>();
  const children = new Map<string, string[]>();
  components.forEach((component, index) => {
    traverseComponent(graph, component, rootsByComponent[index], localDepth, treeRoot, children, compareNodes);
  });

  const depth = new Map<string, number>();
  graph.forEachNode((node) => {
    const offset = treeRoot.get(node) === primaryRoot ? 0 : 1;
    depth.set(node, (localDepth.get(node) ?? 0) + offset);
  });

  // A virtual link from the central root to every other tree is layout-only;
  // the Graphology edge model remains the exact backend projection.
  const rootChildren = [...(children.get(primaryRoot) ?? [])];
  rootChildren.push(...roots.filter((root) => root !== primaryRoot));
  rootChildren.sort(compareNodes);
  children.set(primaryRoot, rootChildren);
  children.forEach((nodes) => nodes.sort(compareNodes));

  let maximumDepth = 0;
  const nodesAtDepth = new Map<number, string[]>();
  graph.forEachNode((node) => {
    const nodeDepth = depth.get(node) ?? 0;
    maximumDepth = Math.max(maximumDepth, nodeDepth);
    const ring = nodesAtDepth.get(nodeDepth) ?? [];
    ring.push(node);
    nodesAtDepth.set(nodeDepth, ring);
  });

  const leaves = new Map<string, number>();
  const deepestFirst = graph
    .nodes()
    .sort((left, right) => (depth.get(right) ?? 0) - (depth.get(left) ?? 0) || compareNodes(left, right));
  for (const node of deepestFirst) {
    const nodeChildren = children.get(node) ?? [];
    leaves.set(
      node,
      nodeChildren.length ? nodeChildren.reduce((total, child) => total + (leaves.get(child) ?? 1), 0) : 1,
    );
  }

  const radius = [0];
  for (let ring = 1; ring <= maximumDepth; ring += 1) {
    const ringNodes = nodesAtDepth.get(ring) ?? [];
    const densityRadius = (ringNodes.length * ringArc(graph, ringNodes)) / (2 * Math.PI);
    radius[ring] = Math.max(radius[ring - 1] + MINIMUM_RING_GAP, densityRadius);
  }

  const pending = [{ node: primaryRoot, start: -Math.PI, end: Math.PI }];
  while (pending.length > 0) {
    const { node, start, end } = pending.pop()!;
    const angle = (start + end) / 2;
    const nodeRadius = radius[depth.get(node) ?? 0] ?? 0;
    graph.mergeNodeAttributes(node, {
      x: Math.cos(angle) * nodeRadius,
      y: Math.sin(angle) * nodeRadius,
    });

    const nodeChildren = children.get(node) ?? [];
    const totalLeaves = nodeChildren.reduce((total, child) => total + (leaves.get(child) ?? 1), 0) || 1;
    let cursor = start;
    const childWedges: Array<{ node: string; start: number; end: number }> = [];
    for (const child of nodeChildren) {
      const span = ((end - start) * (leaves.get(child) ?? 1)) / totalLeaves;
      childWedges.push({ node: child, start: cursor, end: cursor + span });
      cursor += span;
    }
    for (let index = childWedges.length - 1; index >= 0; index -= 1) pending.push(childWedges[index]);
  }

  return { root: primaryRoot, roots, depth };
}
