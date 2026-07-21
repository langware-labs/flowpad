import Graph from 'graphology';
import { applyCircleForestLayout } from '@src/components/graph-view/graph/circleLayout';
import { describe, expect, it } from 'vitest';

function addNode(graph: Graph, key: string, label: string): void {
  graph.addNode(key, { entityType: 'artifact', label, displayLabel: label, x: 0, y: 0 });
}

function radius(graph: Graph, node: string): number {
  return Math.hypot(graph.getNodeAttribute(node, 'x'), graph.getNodeAttribute(node, 'y'));
}

describe('WorldView circle forest layout', () => {
  it('selects a hierarchy root and preserves every disconnected subtree', () => {
    const graph = new Graph({ type: 'directed', multi: true });
    addNode(graph, 'artifact-00-child', 'A child sorts first');
    addNode(graph, 'artifact-10-root', 'Primary hierarchy root');
    addNode(graph, 'artifact-20-grandchild', 'Primary grandchild');
    addNode(graph, 'artifact-30-root', 'Disconnected hierarchy root');
    addNode(graph, 'artifact-40-child', 'Disconnected child');
    graph.addDirectedEdge('artifact-10-root', 'artifact-00-child', { topology: 'hierarchy' });
    graph.addDirectedEdge('artifact-00-child', 'artifact-20-grandchild', { topology: 'hierarchy' });
    graph.addDirectedEdge('artifact-30-root', 'artifact-40-child', { topology: 'hierarchy' });

    const layout = applyCircleForestLayout(graph);

    expect(layout.root).toBe('artifact-10-root');
    expect(layout.roots).toEqual(['artifact-10-root', 'artifact-30-root']);
    expect([...layout.depth.entries()]).toEqual(
      expect.arrayContaining([
        ['artifact-10-root', 0],
        ['artifact-00-child', 1],
        ['artifact-20-grandchild', 2],
        ['artifact-30-root', 1],
        ['artifact-40-child', 2],
      ]),
    );
    expect(radius(graph, 'artifact-10-root')).toBe(0);
    expect(radius(graph, 'artifact-30-root')).toBeGreaterThan(0);
    expect(radius(graph, 'artifact-40-child')).toBeGreaterThan(radius(graph, 'artifact-30-root'));
    const positions = graph
      .nodes()
      .map((node) => `${graph.getNodeAttribute(node, 'x').toFixed(6)},${graph.getNodeAttribute(node, 'y').toFixed(6)}`);
    expect(new Set(positions).size).toBe(graph.order);
  });
});
