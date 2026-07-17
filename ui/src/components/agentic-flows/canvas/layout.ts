/**
 * dagre auto-layout — pure function from snapshot to positioned React Flow
 * nodes/edges. Left-to-right layered layout; runs on structural change only.
 */
import dagre from '@dagrejs/dagre';
import type { Edge, Node } from '@xyflow/react';
import type { FlowGraphSnapshot } from '@sdk/services/flow-manager';

const NODE_W = 220;
const NODE_H = 72;
const TOPIC_W = 190;
const TOPIC_H = 44;

/** THE React Flow edge id — also the store's pulse/traffic key. One builder
 * so the string join can never drift between layout, store, and canvas. */
export function edgeId(kind: string, nodeId: string, topicId: string): string {
  return `${kind}:${nodeId}:${topicId}`;
}

export function layoutSnapshot(snapshot: FlowGraphSnapshot): { nodes: Node[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'LR', nodesep: 36, ranksep: 90 });

  const nodes: Node[] = [];
  const edges: Edge[] = [];

  for (const n of snapshot.nodes) {
    g.setNode(`n:${n.id}`, { width: NODE_W, height: NODE_H });
    nodes.push({
      id: `n:${n.id}`,
      type: 'flowNode',
      position: { x: 0, y: 0 },
      data: { ...n } as Record<string, unknown>,
    });
  }
  for (const t of snapshot.topics) {
    g.setNode(`t:${t.id}`, { width: TOPIC_W, height: TOPIC_H });
    nodes.push({
      id: `t:${t.id}`,
      type: 'topicNode',
      position: { x: 0, y: 0 },
      data: { ...t } as Record<string, unknown>,
    });
  }

  for (const e of snapshot.edges) {
    // listens: topic → node (delivery direction); emits: node → topic.
    const source = e.kind === 'listens' ? `t:${e.topic_id}` : `n:${e.node_id}`;
    const target = e.kind === 'listens' ? `n:${e.node_id}` : `t:${e.topic_id}`;
    const id = edgeId(e.kind, e.node_id, e.topic_id);
    g.setEdge(source, target);
    edges.push({
      id,
      source,
      target,
      type: 'pulse',
      data: { kind: e.kind, topic: e.topic },
      animated: false,
    });
  }

  dagre.layout(g);

  for (const node of nodes) {
    const pos = g.node(node.id);
    if (pos) {
      const w = node.type === 'flowNode' ? NODE_W : TOPIC_W;
      const h = node.type === 'flowNode' ? NODE_H : TOPIC_H;
      node.position = { x: pos.x - w / 2, y: pos.y - h / 2 };
    }
  }
  return { nodes, edges };
}

