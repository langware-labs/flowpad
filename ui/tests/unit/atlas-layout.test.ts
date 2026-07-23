import Graph from 'graphology';
import { describe, expect, it } from 'vitest';
import { buildAtlasLayout } from '@src/components/graph-view/graph/atlasLayout';

describe('Atlas layout', () => {
  it('builds a stable tree and radial presentation from the shared graph', () => {
    const graph = new Graph({ type: 'directed' });
    graph.addNode('root', { label: 'Workspace', entityType: 'workspace' });
    graph.addNode('doc-a', { label: 'Alpha', entityType: 'markdown' });
    graph.addNode('doc-b', { label: 'Beta', entityType: 'markdown' });
    graph.addEdge('root', 'doc-a', { topology: 'hierarchy', kind: 'contains' });
    graph.addEdge('root', 'doc-b', { topology: 'hierarchy', kind: 'contains' });
    graph.setAttribute('worldViewRoot', 'root');

    const layout = buildAtlasLayout(graph);
    expect(layout.root).toBe('root');
    expect(layout.nodes.find((node) => node.id === 'root')?.kind).toBe('root');
    expect(layout.nodes.find((node) => node.id === 'doc-a')?.kind).toBe('doc');
    expect(layout.positions.tree.size).toBe(3);
    expect(layout.positions.radial.size).toBe(3);
    expect(layout.edges.every((edge) => edge.tree)).toBe(true);
  });

  it('lays out a FOREST — every family root keeps its own subtree', () => {
    // A topic taxonomy has many roots. The old layout picked one and parented
    // everything else to it at depth 1, collapsing the graph into one column.
    const graph = new Graph({ type: 'directed' });
    for (const key of ['flow', 'flow.done', 'flow.step', 'app', 'app.route', 'entity']) {
      graph.addNode(key, { label: key, entityType: 'topic' });
    }
    graph.addEdge('flow', 'flow.done', { topology: 'hierarchy', kind: 'child' });
    graph.addEdge('flow', 'flow.step', { topology: 'hierarchy', kind: 'child' });
    graph.addEdge('app', 'app.route', { topology: 'hierarchy', kind: 'child' });

    const layout = buildAtlasLayout(graph);
    const depthOf = (id: string) => layout.nodes.find((node) => node.id === id)?.depth;

    // Each family root sits at depth 0; children one level in — not all at 1.
    expect(depthOf('flow')).toBe(0);
    expect(depthOf('app')).toBe(0);
    expect(depthOf('entity')).toBe(0); // childless root is still a root
    expect(depthOf('flow.done')).toBe(1);
    expect(depthOf('app.route')).toBe(1);

    // Columns are per depth, and each subtree owns a contiguous band of rows.
    const x = (id: string) => layout.positions.tree.get(id)!.x;
    expect(x('flow')).toBe(x('app'));
    expect(x('flow.done')).toBeGreaterThan(x('flow'));
    const y = (id: string) => layout.positions.tree.get(id)!.y;
    expect(Math.abs(y('flow.done') - y('flow'))).toBeLessThan(Math.abs(y('app') - y('flow')) + 1);
  });

  it('association-only nodes hang off their deepest neighbor, not the root', () => {
    const graph = new Graph({ type: 'directed' });
    graph.addNode('flow', { label: 'flow', entityType: 'topic' });
    graph.addNode('flow.runs', { label: 'flow.runs', entityType: 'topic' });
    graph.addNode('doc', { label: 'Runs doc', entityType: 'markdown' });
    graph.addEdge('flow', 'flow.runs', { topology: 'hierarchy', kind: 'child' });
    graph.addEdge('doc', 'flow.runs', { topology: 'association', kind: 'bound' });

    const layout = buildAtlasLayout(graph);
    // Bound one level deeper than the topic it documents (depth 1 → 2).
    expect(layout.nodes.find((node) => node.id === 'doc')?.depth).toBe(2);
  });
});
