import { apiClient } from '@sdk';
import type Graph from 'graphology';
import { graphFromPayload, type GraphLayout, type GraphPayload } from './loadDepGraph';

/**
 * Fetch a named entity-subgraph projection (layer 2 — see
 * flow_sdk/server/routes/subgraph.py) and build the shared Graphology model.
 * `dropOrphans: false` — subgraphs like the tag taxonomy must show unbound
 * leaf nodes.
 */
export async function loadSubgraph(
  projection: string,
  params: Record<string, string>,
  layout: GraphLayout,
): Promise<Graph> {
  const qs = new URLSearchParams(params).toString();
  const data = await apiClient.get<GraphPayload>(`/api/v1/subgraph/${projection}${qs ? `?${qs}` : ''}`);
  return graphFromPayload(data, { layout, directed: layout === 'dagre', dropOrphans: false });
}
