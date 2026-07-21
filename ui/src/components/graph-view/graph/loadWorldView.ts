import { worldViewManager, type WorldViewGraph, type WorldViewProjection } from '@sdk';
import type Graph from 'graphology';
import { graphFromPayload } from './loadDepGraph';
import { compactGraphLabel } from './graphLabels';
import { annotateWorldViewHeat } from './heat';

export function worldViewGraphFromPayload(payload: WorldViewGraph): Graph {
  const graph = graphFromPayload(payload, {
    dropOrphans: false,
    layout: 'circle',
    directed: true,
  });
  graph.forEachNode((node, attributes) => {
    graph.setNodeAttribute(node, 'displayLabel', compactGraphLabel(attributes.label as string));
  });
  annotateWorldViewHeat(graph);
  return graph;
}

export async function loadWorldView(projection: WorldViewProjection): Promise<Graph> {
  const payload = await worldViewManager.load(projection);
  return worldViewGraphFromPayload(payload);
}

export async function refreshWorldView(projection: WorldViewProjection): Promise<Graph> {
  const payload = await worldViewManager.refresh(projection);
  return worldViewGraphFromPayload(payload);
}
