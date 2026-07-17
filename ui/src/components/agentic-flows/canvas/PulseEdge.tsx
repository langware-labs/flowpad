/**
 * Atlas-colored edge: indigo (--flow) for listens, dashed emerald (--rubric)
 * for emits; brightens + carries an animated particle while pulsing; shows a
 * persistent session traffic counter.
 */
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react';
import { useStudio } from '../store';

export function PulseEdge(props: EdgeProps) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data } = props;
  const pulsing = useStudio((s) => s.pulsingEdges.has(id));
  const traffic = useStudio((s) => s.edgeTraffic[id] ?? 0);
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });
  const isEmits = (data as { kind?: string } | undefined)?.kind === 'emits';
  const hot = isEmits ? 'var(--rubric)' : 'var(--flow-hot)';
  const base = isEmits ? 'var(--rubric-dim)' : 'var(--flow)';
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={{
          stroke: pulsing ? hot : base,
          strokeWidth: pulsing ? 2.5 : 1.5,
          strokeDasharray: isEmits ? '6 4' : undefined,
          opacity: pulsing ? 1 : traffic > 0 ? 0.9 : 0.6,
        }}
      />
      {pulsing && (
        <circle r={4.5} fill={hot}>
          <animateMotion dur="0.9s" repeatCount="2" path={path} />
        </circle>
      )}
      {traffic > 0 && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              background: pulsing ? hot : 'var(--paper)',
              border: '1px solid var(--afl-edge)',
              color: pulsing ? 'var(--paper)' : 'var(--ink-faint)',
              borderRadius: 999,
              padding: '0 6px',
              fontSize: 9,
              fontFamily: 'var(--mono)',
              pointerEvents: 'none',
              transition: 'background 200ms',
            }}
          >
            {traffic}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
