import { apiClient } from '@sdk';
import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';
import { iconDataUriForType } from '../icons/iconToDataUri';
import { hexForType } from '../ui/typeColors';
import { paletteForTheme, type EdgeKind, type Theme } from './themeColors';

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

export type GraphEndpoint = {
  type: string;
  id: string;
};

export type GraphNodePayload = {
  type: string;
  id: string;
  label?: string | null;
  is_ghost?: boolean;
  key?: string;
  properties?: Record<string, unknown> | null;
};

export type GraphEdgePayload = {
  from: GraphEndpoint;
  to: GraphEndpoint;
  kind: string;
  topology?: 'hierarchy' | 'association';
};

export type GraphPayload = {
  schema_version?: number;
  projection?: string;
  root?: string | null;
  nodes?: GraphNodePayload[];
  edges?: GraphEdgePayload[];
  counts?: { nodes: number; edges: number };
};

export type GraphLayout = 'force' | 'dagre' | 'circle';

export type LoadOptions = {
  dropOrphans?: boolean;
  theme?: Theme;
};

type BuildOptions = LoadOptions & {
  layout: GraphLayout;
  directed?: boolean;
};

function endpointKey(endpoint: GraphEndpoint): string {
  return `${endpoint.type}-${endpoint.id}`;
}

/**
 * Turn the backend's provider-neutral graph wire shape into the Graphology
 * model shared by both graph viewers. Layout is deliberately not performed
 * here: GraphEngine owns that presentation concern.
 */
export function graphFromPayload(data: GraphPayload | null | undefined, options: BuildOptions): Graph {
  const dropOrphans = options.dropOrphans ?? options.layout === 'force';
  const directed = options.directed ?? options.layout === 'dagre';
  const palette = paletteForTheme(options.theme ?? 'dark');
  const graph = new Graph({ type: directed ? 'directed' : 'undirected', multi: true });
  const nodes = Array.isArray(data?.nodes) ? data.nodes : [];
  const edges = Array.isArray(data?.edges) ? data.edges : [];

  const connected = dropOrphans ? new Set<string>() : null;
  if (connected) {
    for (const edge of edges) {
      connected.add(endpointKey(edge.from));
      connected.add(endpointKey(edge.to));
    }
  }

  for (const node of nodes) {
    const key = node.key || endpointKey(node);
    if (connected && !connected.has(key)) continue;
    const index = graph.order;
    const forceLayout = options.layout === 'force';
    const angle = forceLayout ? index * GOLDEN_ANGLE : 0;
    const radius = forceLayout ? 20 * Math.sqrt(index) : index;
    graph.addNode(key, {
      label: node.label || `${node.type}-${node.id.slice(0, 6)}`,
      entityType: node.type,
      entityId: node.id,
      isGhost: node.is_ghost ?? false,
      properties: node.properties ?? {},
      x: forceLayout ? Math.cos(angle) * radius : radius,
      y: forceLayout ? Math.sin(angle) * radius : 0,
      size: 8,
      color: hexForType(node.type),
      community: 0,
      type: 'image',
      image: iconDataUriForType(node.type),
    });
  }

  const seenEdges = new Set<string>();
  for (const [index, edge] of edges.entries()) {
    const source = endpointKey(edge.from);
    const target = endpointKey(edge.to);
    if (!graph.hasNode(source) || !graph.hasNode(target) || source === target) continue;
    const endpoints = directed || source < target ? [source, target] : [target, source];
    const duplicateKey = JSON.stringify([...endpoints, edge.kind, edge.topology ?? 'association']);
    if (seenEdges.has(duplicateKey)) continue;
    seenEdges.add(duplicateKey);
    const attributes = {
      color: palette.edgeKindColor[edge.kind as EdgeKind] ?? palette.defaultEdgeColor,
      size: 0.6,
      curvature: 0.18,
      kind: edge.kind,
      topology: edge.topology ?? 'association',
    };
    if (directed) {
      graph.addDirectedEdgeWithKey(`e-${index}`, source, target, attributes);
    } else {
      graph.addUndirectedEdgeWithKey(`e-${index}`, source, target, attributes);
    }
  }

  if (data?.root && graph.hasNode(data.root)) graph.setAttribute('worldViewRoot', data.root);
  if (data?.projection) graph.setAttribute('worldViewProjection', data.projection);

  if (options.layout === 'force' && graph.order > 0) {
    louvain.assign(graph);
  }

  graph.forEachNode((node) => {
    const degree = graph.degree(node);
    graph.mergeNodeAttributes(node, {
      size: 7 + Math.min(14, Math.sqrt(degree) * 2),
    });
  });

  return graph;
}

/** Load the existing dependency graph through the authenticated SDK client. */
export async function loadDepGraph(options: LoadOptions = {}): Promise<Graph> {
  const data = await apiClient.get<GraphPayload>('/api/v1/dep_graph');
  return graphFromPayload(data, { ...options, layout: 'force' });
}

/** Rebuild the dependency graph through its standard response envelope. */
export async function rebuildDepGraph(): Promise<void> {
  await apiClient.post('/api/v1/dep_graph/build');
}
