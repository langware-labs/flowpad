import type {
  ArtifactLinkSource,
  DeploymentObservation,
  DeploymentObservationKind,
  DeploymentStatus,
  DeploymentSyncState,
  DeploymentTarget,
  ExternalResourceRef,
} from '../entities/deployment';
import type { FSOriginField } from '../models/FSOrigin';
import { isValidUUIDv4 } from '../models/TypeId';
import { isWorldViewProjection, type WorldViewProjection } from './projection';

/** Edge kinds are backend-owned ontology values and deliberately remain open. */
export type WorldViewEdgeKind = string;
export type WorldViewEdgeTopology = 'hierarchy' | 'association';

export interface WorldViewEndpoint {
  type: string;
  id: string;
}

/**
 * Projection-specific, presentation-safe properties. Known deployment fields
 * remain documented while other projections may add their own safe values.
 */
export interface WorldViewNodeProperties extends Record<string, unknown> {
  kind?: string;
  parent_type_id?: string | null;
  origin?: FSOriginField | null;
  target?: DeploymentTarget | null;
  resource?: ExternalResourceRef | null;
  provider_labels?: Record<string, string>;
  observations?: Partial<Record<DeploymentObservationKind, DeploymentObservation>>;
  status?: DeploymentStatus | null;
  source_revision?: string | null;
  artifact_id?: string | null;
  artifact_link_source?: ArtifactLinkSource | null;
}

export interface WorldViewNode {
  type: string;
  id: string;
  key: string;
  label: string | null;
  is_ghost: boolean;
  properties: WorldViewNodeProperties;
}

export interface WorldViewEdge {
  from: WorldViewEndpoint;
  to: WorldViewEndpoint;
  kind: WorldViewEdgeKind;
  topology: WorldViewEdgeTopology;
}

export interface WorldViewCounts {
  nodes: number;
  edges: number;
}

export type WorldViewSyncState = DeploymentSyncState;

export interface WorldViewSyncSummary {
  provider: string;
  state: WorldViewSyncState;
  observed_at: string | null;
  organizations_total: number;
  organizations_succeeded: number;
  organizations_failed: number;
  resources_seen: number;
  created: number;
  updated: number;
  stale: number;
  warnings: string[];
}

/** Validated projection returned by both load and explicit refresh. */
export interface WorldViewGraph {
  schema_version: 1;
  projection: WorldViewProjection;
  root: string | null;
  nodes: WorldViewNode[];
  edges: WorldViewEdge[];
  counts: WorldViewCounts;
  sync: WorldViewSyncSummary | null;
}

const GRAPH_KEYS = ['schema_version', 'projection', 'root', 'nodes', 'edges', 'counts', 'sync'] as const;
const NODE_KEYS = ['type', 'id', 'key', 'label', 'is_ghost', 'properties'] as const;
const EDGE_KEYS = ['from', 'to', 'kind', 'topology'] as const;
const ENDPOINT_KEYS = ['type', 'id'] as const;
const COUNT_KEYS = ['nodes', 'edges'] as const;

function recordAt(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeysAt(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  if (extra !== undefined) throw new Error(`${path}.${extra} is not part of the WorldView contract`);
}

function trimmedStringAt(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new Error(`${path} must be a non-empty trimmed string`);
  }
  return value;
}

function entityIdAt(value: unknown, path: string): string {
  if (typeof value !== 'string' || value !== value.toLowerCase() || !isValidUUIDv4(value)) {
    throw new Error(`${path} must be a UUID v4 or v5`);
  }
  return value;
}

function nonNegativeIntegerAt(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${path} must be a non-negative integer`);
  }
  return value;
}

function projectionAt(value: unknown): WorldViewProjection {
  if (!isWorldViewProjection(value)) throw new Error('WorldViewGraph.projection is invalid');
  return value;
}

function endpointAt(value: unknown, path: string): WorldViewEndpoint {
  const endpoint = recordAt(value, path);
  exactKeysAt(endpoint, ENDPOINT_KEYS, path);
  return {
    type: trimmedStringAt(endpoint.type, `${path}.type`),
    id: entityIdAt(endpoint.id, `${path}.id`),
  };
}

function nodeAt(value: unknown, index: number): WorldViewNode {
  const path = `WorldViewGraph.nodes[${index}]`;
  const node = recordAt(value, path);
  exactKeysAt(node, NODE_KEYS, path);
  const type = trimmedStringAt(node.type, `${path}.type`);
  const id = entityIdAt(node.id, `${path}.id`);
  const key = trimmedStringAt(node.key, `${path}.key`);
  if (key !== `${type}-${id}`) throw new Error(`${path}.key must match its type and id`);
  if (node.label !== null && typeof node.label !== 'string') {
    throw new Error(`${path}.label must be a string or null`);
  }
  if (typeof node.is_ghost !== 'boolean') throw new Error(`${path}.is_ghost must be a boolean`);
  return {
    type,
    id,
    key,
    label: node.label,
    is_ghost: node.is_ghost,
    properties: { ...recordAt(node.properties, `${path}.properties`) },
  };
}

function edgeAt(value: unknown, index: number): WorldViewEdge {
  const path = `WorldViewGraph.edges[${index}]`;
  const edge = recordAt(value, path);
  exactKeysAt(edge, EDGE_KEYS, path);
  if (edge.topology !== 'hierarchy' && edge.topology !== 'association') {
    throw new Error(`${path}.topology must be hierarchy or association`);
  }
  return {
    from: endpointAt(edge.from, `${path}.from`),
    to: endpointAt(edge.to, `${path}.to`),
    kind: trimmedStringAt(edge.kind, `${path}.kind`),
    topology: edge.topology,
  };
}

const SYNC_STATES: readonly WorldViewSyncState[] = ['current', 'stale', 'partial', 'error'];
const SYNC_COUNT_KEYS = [
  'organizations_total',
  'organizations_succeeded',
  'organizations_failed',
  'resources_seen',
  'created',
  'updated',
  'stale',
] as const;

function syncAt(value: unknown): WorldViewSyncSummary | null {
  if (value === null) return null;
  const sync = recordAt(value, 'WorldViewGraph.sync');
  const provider = trimmedStringAt(sync.provider, 'WorldViewGraph.sync.provider');
  if (typeof sync.state !== 'string' || !SYNC_STATES.includes(sync.state as WorldViewSyncState)) {
    throw new Error('WorldViewGraph.sync.state is invalid');
  }
  if (sync.observed_at !== null && typeof sync.observed_at !== 'string') {
    throw new Error('WorldViewGraph.sync.observed_at must be a string or null');
  }
  if (!Array.isArray(sync.warnings) || !sync.warnings.every((warning) => typeof warning === 'string')) {
    throw new Error('WorldViewGraph.sync.warnings must be a string array');
  }
  const counts = Object.fromEntries(
    SYNC_COUNT_KEYS.map((key) => [key, nonNegativeIntegerAt(sync[key], `WorldViewGraph.sync.${key}`)]),
  ) as Pick<WorldViewSyncSummary, (typeof SYNC_COUNT_KEYS)[number]>;
  return {
    provider,
    state: sync.state as WorldViewSyncState,
    observed_at: sync.observed_at,
    ...counts,
    warnings: [...sync.warnings],
  };
}

/** Parse and validate the shared WorldView wire contract at the SDK boundary. */
export function parseWorldViewGraph(value: unknown): WorldViewGraph {
  const graph = recordAt(value, 'WorldViewGraph');
  exactKeysAt(graph, GRAPH_KEYS, 'WorldViewGraph');
  if (graph.schema_version !== 1) throw new Error('WorldViewGraph.schema_version must be 1');
  if (!Array.isArray(graph.nodes)) throw new Error('WorldViewGraph.nodes must be an array');
  if (!Array.isArray(graph.edges)) throw new Error('WorldViewGraph.edges must be an array');

  const nodes = graph.nodes.map(nodeAt);
  const edges = graph.edges.map(edgeAt);
  const countsValue = recordAt(graph.counts, 'WorldViewGraph.counts');
  exactKeysAt(countsValue, COUNT_KEYS, 'WorldViewGraph.counts');
  const counts: WorldViewCounts = {
    nodes: nonNegativeIntegerAt(countsValue.nodes, 'WorldViewGraph.counts.nodes'),
    edges: nonNegativeIntegerAt(countsValue.edges, 'WorldViewGraph.counts.edges'),
  };
  if (counts.nodes !== nodes.length || counts.edges !== edges.length) {
    throw new Error('WorldViewGraph.counts must match the node and edge arrays');
  }

  const nodeKeys = new Set<string>();
  for (const node of nodes) {
    if (nodeKeys.has(node.key)) throw new Error(`duplicate WorldView node key: ${node.key}`);
    nodeKeys.add(node.key);
  }

  let root: string | null;
  if (graph.root === null) {
    root = null;
  } else {
    root = trimmedStringAt(graph.root, 'WorldViewGraph.root');
    if (!nodeKeys.has(root)) throw new Error('WorldViewGraph.root must reference an existing node');
  }

  const edgeKeys = new Set<string>();
  for (const edge of edges) {
    const source = `${edge.from.type}-${edge.from.id}`;
    const target = `${edge.to.type}-${edge.to.id}`;
    if (!nodeKeys.has(source) || !nodeKeys.has(target)) {
      throw new Error('WorldViewGraph edge endpoints must reference existing nodes');
    }
    const edgeKey = JSON.stringify([source, target, edge.kind, edge.topology]);
    if (edgeKeys.has(edgeKey)) throw new Error('duplicate WorldView edge');
    edgeKeys.add(edgeKey);
  }

  return {
    schema_version: 1,
    projection: projectionAt(graph.projection),
    root,
    nodes,
    edges,
    counts,
    sync: syncAt(graph.sync),
  };
}
