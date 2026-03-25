import React from 'react';

interface EdgeCoords {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Draws a smooth cubic bezier arrow between two points. */
export function PipelineEdgeArrow({ x1, y1, x2, y2 }: EdgeCoords) {
  const cx1 = x1 + (x2 - x1) * 0.5;
  const cy1 = y1;
  const cx2 = x1 + (x2 - x1) * 0.5;
  const cy2 = y2;

  const d = `M ${x1} ${y1} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${x2} ${y2}`;

  return (
    <g>
      <path d={d} fill="none" stroke="#94a3b8" strokeWidth={1.5} markerEnd="url(#arrow)" />
    </g>
  );
}

/** Reusable SVG defs — render once inside the canvas SVG. */
export function ArrowDefs() {
  return (
    <defs>
      <marker
        id="arrow"
        markerWidth="8"
        markerHeight="8"
        refX="6"
        refY="3"
        orient="auto"
        markerUnits="strokeWidth"
      >
        <path d="M0,0 L0,6 L8,3 z" fill="#94a3b8" />
      </marker>
    </defs>
  );
}
