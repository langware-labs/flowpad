import type { Pipeline, PipelineNode } from '@sdk';
import React, { useMemo } from 'react';
import { ArrowDefs, PipelineEdgeArrow } from './PipelineEdgeArrow';
import { NODE_H, NODE_W, PipelineNodeCard } from './PipelineNodeCard';

const COL_GAP = 80;
const ROW_GAP = 24;
const CANVAS_PAD = 32;

interface NodeLayout {
  node: PipelineNode;
  x: number;
  y: number;
}

function computeLayout(pipeline: Pipeline): NodeLayout[] {
  const { nodes, edges } = pipeline;
  if (nodes.length === 0) return [];

  // Build outgoing edge map
  const outEdges = new Map<string, string[]>();
  for (const edge of edges) {
    const list = outEdges.get(edge.from_node) ?? [];
    list.push(edge.to_node);
    outEdges.set(edge.from_node, list);
  }

  // BFS to assign column depth
  const depth = new Map<string, number>();
  const startId = nodes[0]?.id ?? '';
  depth.set(startId, 0);
  const queue = [startId];

  while (queue.length > 0) {
    const id = queue.shift()!;
    const d = depth.get(id) ?? 0;
    for (const next of outEdges.get(id) ?? []) {
      if (!depth.has(next)) {
        depth.set(next, d + 1);
        queue.push(next);
      }
    }
  }

  // Assign any nodes not reached by BFS (disconnected)
  const maxDepth = Math.max(0, ...depth.values());
  for (const node of nodes) {
    if (!depth.has(node.id)) {
      depth.set(node.id, maxDepth + 1);
    }
  }

  // Group nodes by column
  const cols = new Map<number, string[]>();
  for (const [id, d] of depth) {
    const arr = cols.get(d) ?? [];
    arr.push(id);
    cols.set(d, arr);
  }

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  // Compute max rows per column to center each column vertically
  const maxRows = Math.max(1, ...Array.from(cols.values()).map((ids) => ids.length));
  const totalHeight = maxRows * NODE_H + (maxRows - 1) * ROW_GAP;

  const layouts: NodeLayout[] = [];

  for (const [col, ids] of cols) {
    const colHeight = ids.length * NODE_H + (ids.length - 1) * ROW_GAP;
    const topOffset = (totalHeight - colHeight) / 2;

    ids.forEach((id, row) => {
      const node = nodeMap.get(id);
      if (!node) return;
      layouts.push({
        node,
        x: CANVAS_PAD + col * (NODE_W + COL_GAP),
        y: CANVAS_PAD + topOffset + row * (NODE_H + ROW_GAP),
      });
    });
  }

  return layouts;
}

interface PipelineCanvasProps {
  pipeline: Pipeline;
}

export function PipelineCanvas({ pipeline }: PipelineCanvasProps) {
  const layouts = useMemo(() => computeLayout(pipeline), [pipeline]);

  const posMap = useMemo(() => {
    const m = new Map<string, { x: number; y: number }>();
    for (const { node, x, y } of layouts) {
      m.set(node.id, { x, y });
    }
    return m;
  }, [layouts]);

  const totalWidth  = useMemo(() => {
    if (layouts.length === 0) return 400;
    return Math.max(...layouts.map((l) => l.x + NODE_W)) + CANVAS_PAD;
  }, [layouts]);

  const totalHeight = useMemo(() => {
    if (layouts.length === 0) return 200;
    return Math.max(...layouts.map((l) => l.y + NODE_H)) + CANVAS_PAD;
  }, [layouts]);

  // Build edge coords: exit right-center of source, enter left-center of target
  const edgeCoords = useMemo(() => {
    return pipeline.edges.map((edge) => {
      const src = posMap.get(edge.from_node);
      const dst = posMap.get(edge.to_node);
      if (!src || !dst) return null;

      // Find port index for vertical offset
      const srcNode = pipeline.nodes.find((n) => n.id === edge.from_node);
      const dstNode = pipeline.nodes.find((n) => n.id === edge.to_node);
      const srcPorts = srcNode ? Object.keys(srcNode.outputs) : [];
      const dstPorts = dstNode ? Object.keys(dstNode.inputs) : [];
      const srcIdx = Math.max(0, srcPorts.indexOf(edge.from_port));
      const dstIdx = Math.max(0, dstPorts.indexOf(edge.to_port));

      return {
        id: edge.id,
        x1: src.x + NODE_W,
        y1: src.y + NODE_H / 2 + srcIdx * 14,
        x2: dst.x,
        y2: dst.y + NODE_H / 2 + dstIdx * 14,
      };
    }).filter(Boolean) as Array<{ id: string; x1: number; y1: number; x2: number; y2: number }>;
  }, [pipeline, posMap]);

  return (
    <div className="relative overflow-auto">
      <div style={{ width: totalWidth, height: totalHeight, position: 'relative' }}>
        {/* SVG arrow layer */}
        <svg
          style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
          width={totalWidth}
          height={totalHeight}
        >
          <ArrowDefs />
          {edgeCoords.map((c) => (
            <PipelineEdgeArrow key={c.id} x1={c.x1} y1={c.y1} x2={c.x2} y2={c.y2} />
          ))}
        </svg>

        {/* Node cards */}
        {layouts.map(({ node, x, y }) => (
          <div key={node.id} style={{ position: 'absolute', left: x, top: y }}>
            <PipelineNodeCard node={node} />
          </div>
        ))}
      </div>
    </div>
  );
}
