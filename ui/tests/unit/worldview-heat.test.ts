import Graph from 'graphology';
import {
  COLD_HEAT_COLOR,
  HOT_HEAT_COLOR,
  UNKNOWN_HEAT_COLOR,
  annotateWorldViewHeat,
  childFootprints,
  heatColor,
  heatSummaryForGraph,
  normalizeHeatValues,
  type WorldViewNodeHeat,
  colorForWorldViewMode,
} from '@src/components/graph-view/graph/heat';
import { hexForType } from '@src/components/graph-view/ui/typeColors';
import { describe, expect, it } from 'vitest';

function hierarchy(): Graph {
  const graph = new Graph({ type: 'directed' });
  graph.addNode('root', { x: 1, y: 2, color: '#111111', properties: {} });
  graph.addNode('child', { x: 3, y: 4, color: '#222222', properties: {} });
  graph.addNode('grandchild', { x: 5, y: 6, color: '#333333', properties: {} });
  graph.addNode('deployment', { x: 7, y: 8, color: '#444444', properties: {} });
  graph.addDirectedEdge('root', 'child', { kind: 'child' });
  graph.addDirectedEdge('child', 'grandchild', { kind: 'child' });
  graph.addDirectedEdge('root', 'deployment', { kind: 'deployed_as' });
  return graph;
}

describe('WorldView heat derivation', () => {
  it('keeps Artifact and Deployment distinct in the default type mode', () => {
    expect(hexForType('artifact')).not.toBe(hexForType('deployment'));
    expect(hexForType('artifact')).not.toBe(UNKNOWN_HEAT_COLOR);
    expect(hexForType('deployment')).not.toBe(UNKNOWN_HEAT_COLOR);
  });

  it('counts the inclusive recursive child hierarchy and ignores other edges', () => {
    const graph = hierarchy();

    expect(Object.fromEntries(childFootprints(graph))).toEqual({
      root: 3,
      child: 2,
      grandchild: 1,
      deployment: 1,
    });
  });

  it('annotates immutable footprint values and leaves absent observations unknown', () => {
    const graph = hierarchy();
    annotateWorldViewHeat(graph);
    const heat = graph.getNodeAttribute('root', 'worldViewHeat') as WorldViewNodeHeat;

    expect(heat.footprint.value).toBe(3);
    expect(heat.cost).toMatchObject({ value: null, normalized: null, color: UNKNOWN_HEAT_COLOR });
    expect(Object.isFrozen(heat)).toBe(true);
    expect(Object.isFrozen(heat.footprint)).toBe(true);
    expect(heatSummaryForGraph(graph, 'cost')).toMatchObject({ known: 0, unknown: 4, total: 4 });
  });

  it('normalizes only comparable metric/unit/window cohorts', () => {
    const graph = new Graph({ type: 'directed' });
    const cost = (value: number, unit: string) => ({
      observations: {
        cost: {
          metric: 'cost.net',
          value,
          unit,
          coverage: 'available',
          window_start: '2026-07-01T00:00:00Z',
          window_end: '2026-08-01T00:00:00Z',
        },
      },
    });
    graph.addNode('usd-low', { properties: cost(10, 'USD') });
    graph.addNode('usd-high', { properties: cost(20, 'USD') });
    graph.addNode('eur', { properties: cost(15, 'EUR') });
    annotateWorldViewHeat(graph);

    const low = graph.getNodeAttribute('usd-low', 'worldViewHeat') as WorldViewNodeHeat;
    const high = graph.getNodeAttribute('usd-high', 'worldViewHeat') as WorldViewNodeHeat;
    const euro = graph.getNodeAttribute('eur', 'worldViewHeat') as WorldViewNodeHeat;
    expect(low.cost.normalized).toBe(0);
    expect(high.cost.normalized).toBe(1);
    expect(euro.cost.normalized).toBe(0.5);
    expect(heatSummaryForGraph(graph, 'cost')).toMatchObject({ known: 3, cohorts: 2 });
  });

  it('uses robust log/quartile normalization and stable palette endpoints', () => {
    const normalized = normalizeHeatValues([1, 2, 3, 4, 1_000_000_000]);

    expect(normalized[0]).toBe(0);
    expect(normalized[3]).toBeGreaterThan(0.5);
    expect(normalized[4]).toBe(1);
    expect(heatColor(0)).toBe(COLD_HEAT_COLOR);
    expect(heatColor(1)).toBe(HOT_HEAT_COLOR);
  });

  it('changes color mode without mutating graph topology or coordinates', () => {
    const graph = hierarchy();
    annotateWorldViewHeat(graph);
    const nodes = graph.nodes();
    const edges = graph.edges();
    const coordinates = nodes.map((node) => [
      graph.getNodeAttribute(node, 'x'),
      graph.getNodeAttribute(node, 'y'),
    ]);
    graph.forEachNode((_node, attributes) => colorForWorldViewMode(attributes, 'footprint'));

    expect(graph.nodes()).toEqual(nodes);
    expect(graph.edges()).toEqual(edges);
    expect(nodes.map((node) => [graph.getNodeAttribute(node, 'x'), graph.getNodeAttribute(node, 'y')])).toEqual(coordinates);
  });
});
