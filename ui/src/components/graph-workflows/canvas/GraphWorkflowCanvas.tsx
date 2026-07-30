/**
 * The flow canvas. Structure derives from graph.json (doc); positions from
 * display.json (auto-grid fallback for unplaced nodes). React Flow keeps a
 * local mirror (so selection/drag stay native); the mirror is rebuilt on
 * structural change. Every structural gesture is a doc mutation (persisted
 * debounced by the store's writers): connect → new edge, ⌫ → drop
 * nodes+edges, palette drop → new node. Drag-end writes display.json only.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Background,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { GraphWorkflowDocNode } from '@sdk/services/graph-workflows';
import { StationCard, TriggerNode } from './nodes';
import { PulseEdge } from './PulseEdge';
import { newNodeId, useStudio } from '../store';
import { PALETTE_DRAG_MIME, defaultNodeData, paletteLabel } from '../panels/PaletteTab';

const nodeTypes = { trigger: TriggerNode, station: StationCard };
const edgeTypes = { pulse: PulseEdge };

/** Default event emitted by a source node type — seeds a new edge's label. */
function defaultEventFor(node: GraphWorkflowDocNode | undefined): string {
  if (!node) return '*';
  if (node.node_type === 'trigger') return 'fired';
  return 'done';  // agents + functions auto-emit `done`
}

function CanvasInner() {
  const doc = useStudio((s) => s.doc);
  const mutateDoc = useStudio((s) => s.mutateDoc);
  const { screenToFlowPosition } = useReactFlow();
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);

  // Rebuild the mirror on structural change only (ids/types/edge routing/name),
  // not on every keystroke in the inspector or drag frame.
  const structureKey = useMemo(() => {
    if (!doc) return '';
    return [
      doc.nodes.map((n) => `${n.id}:${n.node_type}:${n.name}:${JSON.stringify(n.node_data)}`).join(','),
      doc.edges.map((e) => `${e.id}:${e.from.node}:${e.from.event}:${e.to.node}`).join(','),
    ].join('|');
  }, [doc]);

  useEffect(() => {
    if (!doc) {
      setNodes([]);
      setEdges([]);
      return;
    }
    const display = useStudio.getState().display;
    setNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n]));
      return doc.nodes.map((n, i) => ({
        id: n.id,
        type: n.node_type === 'trigger' ? 'trigger' : 'station',
        position:
          prevById.get(n.id)?.position ??
          display.nodes[n.id] ?? { x: 80 + (i % 3) * 300, y: 80 + Math.floor(i / 3) * 170 },
        selected: prevById.get(n.id)?.selected ?? false,
        data: { def: n },
      }));
    });
    setEdges((prev) => {
      const prevById = new Map(prev.map((e) => [e.id, e]));
      return doc.edges.map((e) => ({
        id: e.id,
        source: e.from.node,
        target: e.to.node,
        type: 'pulse',
        selected: prevById.get(e.id)?.selected ?? false,
        data: { event: e.from.event },
      }));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structureKey]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    for (const ch of changes) {
      // Selection opens the inspector (more reliable than onNodeClick, which a
      // 1px drag suppresses). Position persists on drag-END only.
      if (ch.type === 'select' && ch.selected) {
        useStudio.getState().selectNode(ch.id);
      }
      if (ch.type === 'position' && !ch.dragging && ch.position) {
        useStudio.getState().moveNode(ch.id, Math.round(ch.position.x), Math.round(ch.position.y));
      }
    }
    setNodes((ns) => applyNodeChanges(changes, ns));
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges((es) => applyEdgeChanges(changes, es));
  }, []);

  const onConnect = useCallback(
    (conn: Connection) => {
      if (!conn.source || !conn.target || conn.source === conn.target) return;
      mutateDoc((d) => {
        const src = d.nodes.find((n) => n.id === conn.source);
        const tgt = d.nodes.find((n) => n.id === conn.target);
        if (!src || !tgt || tgt.node_type === 'trigger') return d;
        d.edges.push({
          id: newNodeId(),
          from: { node: conn.source, event: defaultEventFor(src) },
          to: { node: conn.target },
        });
        return d;
      });
    },
    [mutateDoc],
  );

  const onNodesDelete = useCallback(
    (deleted: Node[]) => {
      const gone = new Set(deleted.map((n) => n.id));
      useStudio.getState().selectNode(null);
      mutateDoc((d) => ({
        ...d,
        nodes: d.nodes.filter((n) => !gone.has(n.id)),
        edges: d.edges.filter((e) => !gone.has(e.from.node) && !gone.has(e.to.node)),
      }));
    },
    [mutateDoc],
  );

  const onEdgesDelete = useCallback(
    (deleted: Edge[]) => {
      const gone = new Set(deleted.map((e) => e.id));
      mutateDoc((d) => ({ ...d, edges: d.edges.filter((e) => !gone.has(e.id)) }));
    },
    [mutateDoc],
  );

  // Palette drop → new node at the drop point (n8n pattern).
  const onDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes(PALETTE_DRAG_MIME)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      const nodeType = e.dataTransfer.getData(PALETTE_DRAG_MIME) as GraphWorkflowDocNode['node_type'];
      if (!nodeType) return;
      e.preventDefault();
      const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const id = newNodeId();
      useStudio.getState().moveNode(id, Math.round(pos.x - 110), Math.round(pos.y - 40));
      mutateDoc((d) => {
        d.nodes.push({ id, node_type: nodeType, name: paletteLabel(nodeType), node_data: defaultNodeData(nodeType) });
        return d;
      });
      useStudio.getState().selectNode(id);
    },
    [mutateDoc, screenToFlowPosition],
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onNodesDelete={onNodesDelete}
      onEdgesDelete={onEdgesDelete}
      onDragOver={onDragOver}
      onDrop={onDrop}
      deleteKeyCode={['Backspace', 'Delete']}
      fitView
      colorMode="dark"
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={24} color="#262a38" />
      <Controls />
    </ReactFlow>
  );
}

export function GraphWorkflowCanvas() {
  return (
    <ReactFlowProvider>
      <CanvasInner />
    </ReactFlowProvider>
  );
}
