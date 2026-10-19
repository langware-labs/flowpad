/**
 * Event edge: carries the event-name chip at its midpoint (`*` styled as the
 * catch-all), brightens + animates a particle while an event traverses it.
 * Selecting the edge turns the chip into an inline input — renaming the event
 * IS a doc mutation.
 */
import { useEffect, useState } from 'react';
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react';
import { useStudio } from '../store';

export function PulseEdge(props: EdgeProps) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected } = props;
  const pulsing = useStudio((s) => s.hot.has(id));
  const mutateDoc = useStudio((s) => s.mutateDoc);
  const event = String((data as { event?: string } | undefined)?.event ?? '*');
  const isCatchAll = event === '*';
  const [draft, setDraft] = useState(event);
  useEffect(() => setDraft(event), [event, selected]);

  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  const commit = () => {
    const next = draft.trim() || '*';
    if (next === event) return;
    mutateDoc((d) => {
      const e = d.edges.find((x) => x.id === id);
      if (e) e.from.event = next;
      return d;
    });
  };

  const hot = 'var(--flow-hot)';
  const base = isCatchAll ? 'var(--rubric-dim)' : 'var(--flow)';
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={{
          stroke: pulsing ? hot : selected ? 'var(--ink-strong)' : base,
          strokeWidth: pulsing || selected ? 2.5 : 1.5,
          strokeDasharray: isCatchAll ? '6 4' : undefined,
          opacity: pulsing ? 1 : 0.75,
        }}
      />
      {pulsing && (
        <circle r={4.5} fill={hot}>
          <animateMotion dur="0.9s" repeatCount="2" path={path} />
        </circle>
      )}
      <EdgeLabelRenderer>
        <div
          className={`afl-evtchip nodrag nopan ${isCatchAll ? 'catchall' : ''} ${pulsing ? 'hot' : ''}`}
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: 'all',
          }}
        >
          {selected ? (
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              }}
              size={Math.max(3, draft.length)}
            />
          ) : (
            <span>{event}</span>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
