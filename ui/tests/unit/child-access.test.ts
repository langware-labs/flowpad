import { parseWorldViewGraph, WorldViewProjection } from '@sdk';
import { describe, expect, it } from 'vitest';

import { isOverrideMapping, mappingLabel } from '@src/components/graph-view/graph/accessEdges';
import { graphFromPayload } from '@src/components/graph-view/graph/loadDepGraph';

const TEAM_ID = '11111111-1111-4111-8111-111111111111';
const CONV_ID = '22222222-2222-4222-8222-222222222222';

function node(type: string, id: string) {
  return { type, id, key: `${type}-${id}`, label: type, is_ghost: false, properties: {} };
}

function graphWith(edges: unknown[]) {
  return {
    schema_version: 1,
    projection: WorldViewProjection.ORGANIZATION,
    root: null,
    nodes: [node('team', TEAM_ID), node('conversation', CONV_ID)],
    edges,
    counts: { nodes: 2, edges: edges.length },
    sync: null,
  };
}

function edge(from_role: string | null, kind: string, topology: 'hierarchy' | 'association') {
  return {
    from: { type: 'team', id: TEAM_ID },
    to: { type: 'conversation', id: CONV_ID },
    kind,
    topology,
    from_role,
  };
}

describe('isOverrideMapping', () => {
  it('leaves the pass-through every child starts with unannotated', () => {
    expect(isOverrideMapping('*', '*', 'hierarchy')).toBe(false);
  });

  it('annotates containment that no longer passes roles through', () => {
    expect(isOverrideMapping('*', 'reader', 'hierarchy')).toBe(true);
    expect(isOverrideMapping('admin', 'member', 'hierarchy')).toBe(true);
  });

  it('treats a named source role as a written rule wherever it sits', () => {
    // Only the FIRST rule rides the containment edge; the rest are ordinary role
    // edges beside it, and they would go unlabelled without this.
    expect(isOverrideMapping('admin', 'member', 'association')).toBe(true);
  });

  it('leaves an ordinary grant alone', () => {
    // A plain membership grant is always `* -> <role>` on a non-containment edge.
    // Annotating those would put a badge on nearly every edge in the graph.
    expect(isOverrideMapping('*', 'owner', 'association')).toBe(false);
  });

  it('says nothing when the hub reported no mapping', () => {
    expect(isOverrideMapping(null, 'owner', 'association')).toBe(false);
    expect(isOverrideMapping(undefined, 'owner', 'hierarchy')).toBe(false);
  });

  it('renders the badge as source → conferred', () => {
    expect(mappingLabel('admin', 'member')).toBe('admin → member');
  });
});

describe('from_role on the wire', () => {
  it('parses through and defaults to null when absent', () => {
    const withRole = parseWorldViewGraph(graphWith([edge('admin', 'member', 'hierarchy')]));
    expect(withRole.edges[0].from_role).toBe('admin');

    const legacy = graphWith([
      {
        from: { type: 'team', id: TEAM_ID },
        to: { type: 'conversation', id: CONV_ID },
        kind: 'member',
        topology: 'association',
      },
    ]);
    expect(parseWorldViewGraph(legacy).edges[0].from_role).toBeNull();
  });

  it('rejects a non-string from_role rather than passing it to the renderer', () => {
    const bad = graphWith([{ ...edge('admin', 'member', 'hierarchy'), from_role: 7 }]);
    expect(() => parseWorldViewGraph(bad)).toThrow(/from_role/);
  });

  it('keeps two rules that confer the same role but match different sources', () => {
    // Keyed without `from_role` these read as one duplicate edge and the whole
    // graph is rejected.
    const both = graphWith([edge('admin', 'reader', 'hierarchy'), edge('editor', 'reader', 'association')]);
    expect(parseWorldViewGraph(both).edges).toHaveLength(2);
  });
});

describe('graphFromPayload', () => {
  it('badges only the overridden edge and keeps both mappings', () => {
    const graph = graphFromPayload(
      { nodes: [node('team', TEAM_ID), node('conversation', CONV_ID)], edges: [edge('admin', 'member', 'hierarchy')] },
      { dropOrphans: false, layout: 'circle', directed: true },
    );
    const labels: unknown[] = [];
    graph.forEachEdge((_e, attrs) => labels.push(attrs.label));
    expect(labels).toEqual(['admin → member']);
  });

  it('leaves an inherited edge unlabelled', () => {
    const graph = graphFromPayload(
      { nodes: [node('team', TEAM_ID), node('conversation', CONV_ID)], edges: [edge('*', '*', 'hierarchy')] },
      { dropOrphans: false, layout: 'circle', directed: true },
    );
    const labels: unknown[] = [];
    graph.forEachEdge((_e, attrs) => labels.push(attrs.label));
    expect(labels).toEqual([undefined]);
  });
});
