/**
 * The wiring canvas. Controlled React Flow: positioned nodes/edges derive from
 * the snapshot (dagre layout on structural change only); live events pulse
 * edges without touching graph data. Connecting a flow-node handle to a topic
 * handle creates a Listens edge via the SDK.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Background,
  Controls,
  ReactFlow,
  applyNodeChanges,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import apiClient from '@sdk/client';
import { flowManager } from '@sdk/services/flow-manager';
import { edgeId, layoutSnapshot } from './layout';
import { FlowNodeCard, TopicPill } from './nodes';
import { PulseEdge } from './PulseEdge';
import { useStudio } from '../store';

const nodeTypes = { flowNode: FlowNodeCard, topicNode: TopicPill };
const edgeTypes = { pulse: PulseEdge };

export function FlowCanvas() {
  const snapshot = useStudio((s) => s.snapshot);
  const setSnapshot = useStudio((s) => s.setSnapshot);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);

  // Re-layout on structural change only.
  const structureKey = useMemo(() => {
    if (!snapshot) return '';
    return [
      snapshot.nodes.map((n) => n.id).join(','),
      snapshot.topics.map((t) => t.id).join(','),
      snapshot.edges.map((e) => edgeId(e.kind, e.node_id, e.topic_id)).join(','),
    ].join('|');
  }, [snapshot]);

  useEffect(() => {
    if (!snapshot) return;
    const laid = layoutSnapshot(snapshot);
    setNodes(laid.nodes);
    setEdges(laid.edges);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structureKey]);

  // Structural refresh only: a topic event may have minted new topics or
  // stamped an emits edge — refetch the wiring (debounced). Liveness
  // (counters/pulses/status) is fully push-driven via node_status; no polling.
  useEffect(() => {
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const onEvent = (e: { topic: string }) => {
      const snap = useStudio.getState().snapshot;
      const known = snap?.topics.some((t) => t.name === e.topic);
      const emitsKnown = snap?.edges.some((ed) => ed.kind === 'emits' && ed.topic === e.topic);
      if (known && emitsKnown) return;
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(async () => {
        const fresh = await flowManager.fetchGraph().catch(() => undefined);
        if (fresh) setSnapshot(fresh);
      }, 800);
    };
    flowManager.on('topic_event', onEvent);
    return () => {
      flowManager.off('topic_event', onEvent);
      if (refreshTimer) clearTimeout(refreshTimer);
    };
  }, [setSnapshot]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    // Selection drives the inspector: selecting a flow node opens its panel
    // (more reliable than onNodeClick, which a 1px drag suppresses).
    for (const ch of changes) {
      if (ch.type === 'select' && ch.selected && ch.id.startsWith('n:')) {
        useStudio.getState().selectNode(ch.id.slice(2));
      }
    }
    setNodes((ns) => applyNodeChanges(changes, ns));
  }, []);

  // Drag node→topic (or topic→node) to declare a Listens edge.
  const onConnect = useCallback(
    async (conn: Connection) => {
      const src = conn.source ?? '';
      const tgt = conn.target ?? '';
      const nodeId = src.startsWith('n:') ? src.slice(2) : tgt.startsWith('n:') ? tgt.slice(2) : null;
      const topicId = src.startsWith('t:') ? src.slice(2) : tgt.startsWith('t:') ? tgt.slice(2) : null;
      if (!nodeId || !topicId) return;
      try {
        await apiClient.post(`/graph/flow_node/${nodeId}/wire`, { topic_id: topicId });
      } catch (err) {
        console.error('wire failed', err);
      }
      const snap = await flowManager.fetchGraph();
      if (snap) setSnapshot(snap);
    },
    [setSnapshot],
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      onConnect={onConnect}
      fitView
      colorMode="dark"
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={24} color="#262a38" />
      <Controls />
    </ReactFlow>
  );
}
