import { worldViewManager } from '@sdk';
import type Graph from 'graphology';
import { graphFromPayload, type GraphNodePayload, type GraphPayload, type LoadOptions } from './loadDepGraph';
import { compactGraphLabel } from './graphLabels';
import { annotateWorldViewHeat } from './heat';

export const WORLDVIEW_PROPERTY_KEYS = [
  'kind',
  'origin',
  'target',
  'resource',
  'provider_labels',
  'status',
  'observed_at',
  'observation',
  'observations',
  'source_revision',
] as const;

export type WorldViewPropertyKey = (typeof WORLDVIEW_PROPERTY_KEYS)[number];

/**
 * Provider inventory can contain broad metadata. Only this deliberately small
 * presentation contract crosses into the selected-node panel.
 */
export function safeWorldViewProperties(node: GraphNodePayload): Record<string, unknown> {
  const source = node.properties && typeof node.properties === 'object' ? node.properties : {};
  const safe: Record<string, unknown> = {};
  for (const key of WORLDVIEW_PROPERTY_KEYS) {
    const value = source[key];
    if (value !== undefined && value !== null) safe[key] = value;
  }
  return safe;
}

export function worldViewGraphFromPayload(payload: GraphPayload, options: LoadOptions = {}): Graph {
  const graph = graphFromPayload(payload, {
    ...options,
    dropOrphans: false,
    layout: 'force',
    directed: true,
    propertyPicker: safeWorldViewProperties,
  });
  graph.forEachNode((node, attributes) => {
    graph.setNodeAttribute(node, 'displayLabel', compactGraphLabel(attributes.label as string));
  });
  annotateWorldViewHeat(graph);
  return graph;
}

export async function loadWorldView(options: LoadOptions = {}): Promise<Graph> {
  const payload = await worldViewManager.load();
  return worldViewGraphFromPayload(payload, options);
}

export async function syncWorldView(options: LoadOptions = {}): Promise<Graph> {
  const payload = await worldViewManager.sync();
  return worldViewGraphFromPayload(payload, options);
}
