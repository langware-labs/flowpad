// WorkflowTraceGutter.tsx — pure display component, no event collection
import { getEventColor, getEventIcon } from '@src/components/hooks/event-utils';
import type { ClaudeTraceEvent } from '@src/types/trace-event';
import React, { useEffect, useMemo, useRef, useState } from 'react';

interface BlockPosition {
  text: string;
  top: number;
}

interface Props {
  workerSessionId: string | null;
  editorContainerRef: React.RefObject<HTMLDivElement>;
  displayEvents: ClaudeTraceEvent[];
  traceHistory: { sessionId: string; events: ClaudeTraceEvent[] }[];
  selectedHistoryIdx: number | null;
  onSelectHistory: (idx: number | null) => void;
}

export function WorkflowTraceGutter({
  workerSessionId,
  editorContainerRef,
  displayEvents,
  traceHistory,
  selectedHistoryIdx,
  onSelectHistory,
}: Props) {
  // Measure ProseMirror block positions
  const [blockMap, setBlockMap] = useState<BlockPosition[]>([]);
  const [scrollTop, setScrollTop] = useState(0);
  const rebuildTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const container = editorContainerRef.current;
    if (!container) return;

    const rebuild = () => {
      const proseMirror = container.querySelector('.ProseMirror');
      if (!proseMirror) return;
      const containerRect = proseMirror.getBoundingClientRect();
      const blocks: BlockPosition[] = [];
      proseMirror.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li').forEach((el) => {
        const rect = el.getBoundingClientRect();
        blocks.push({
          text: el.textContent?.trim().toLowerCase() ?? '',
          top: rect.top - containerRect.top + container.scrollTop,
        });
      });
      setBlockMap(blocks);
    };

    // Debounced rebuild to avoid flooding state updates from MutationObserver
    const debouncedRebuild = () => {
      if (rebuildTimerRef.current) clearTimeout(rebuildTimerRef.current);
      rebuildTimerRef.current = setTimeout(rebuild, 100);
    };

    rebuild();

    const ro = new ResizeObserver(debouncedRebuild);
    const mo = new MutationObserver(debouncedRebuild);

    const proseMirror = container.querySelector('.ProseMirror');
    if (proseMirror) {
      ro.observe(proseMirror);
      // childList only — no characterData to avoid per-keystroke fires
      mo.observe(proseMirror, { childList: true, subtree: true });
    }

    const onScroll = () => setScrollTop(container.scrollTop);
    container.addEventListener('scroll', onScroll);

    return () => {
      if (rebuildTimerRef.current) clearTimeout(rebuildTimerRef.current);
      ro.disconnect();
      mo.disconnect();
      container.removeEventListener('scroll', onScroll);
    };
  }, [editorContainerRef]);

  // Match each event to a block
  function matchEventToBlock(event: ClaudeTraceEvent): BlockPosition | null {
    // workflow_trace events (hook_op) store label/phase in event_data;
    // agent_hook events store them in raw_hook_data — check both.
    const data = (event.hook_data?.event_data ?? event.hook_data?.raw_hook_data) as Record<string, unknown> | undefined;
    const label = (typeof data?.label === 'string' ? data.label : '').toLowerCase();
    const phase = (typeof data?.phase === 'string' ? data.phase : '').toLowerCase();
    const candidates = [label, phase].filter(Boolean);
    for (const needle of candidates) {
      const match = blockMap.find(
        (b) => b.text.includes(needle) || needle.includes(b.text),
      );
      if (match) return match;
    }
    return null;
  }

  // Build positioned annotations
  const positioned = useMemo(() => {
    const map = new Map<number, ClaudeTraceEvent[]>();
    for (const e of displayEvents) {
      const block = matchEventToBlock(e);
      if (!block) continue;
      const key = Math.round(block.top);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(e);
    }
    return Array.from(map.entries()).map(([top, evts]) => ({ top, events: evts }));
  }, [displayEvents, blockMap]); // eslint-disable-line react-hooks/exhaustive-deps

  const hasEvents = displayEvents.length > 0 || traceHistory.length > 0;

  if (!hasEvents && !workerSessionId) return null;

  return (
    <div
      data-testid="workflow-annotation-gutter"
      className="relative flex h-full w-44 flex-shrink-0 flex-col overflow-hidden border-l border-border bg-background/50"
    >
      {/* Run history dropdown */}
      <div className="flex-shrink-0 border-b border-border px-2 py-1">
        <select
          className="w-full bg-transparent text-xs text-muted-foreground"
          value={selectedHistoryIdx ?? 'current'}
          onChange={(e) => {
            const v = e.target.value;
            onSelectHistory(v === 'current' ? null : Number(v));
          }}
        >
          <option value="current">Current run</option>
          {traceHistory.map((h, i) => (
            <option key={h.sessionId} value={i}>
              Run {i + 1} ({h.events.length} events)
            </option>
          ))}
        </select>
      </div>

      {/* Annotation chips */}
      <div className="relative flex-1 overflow-hidden">
        {positioned.map(({ top, events: evts }) => {
          const displayTop = top - scrollTop;
          if (displayTop < 0) return null;
          const lastEvent = evts[evts.length - 1];
          const Icon = getEventIcon(lastEvent.event_type, lastEvent);
          const color = getEventColor(lastEvent);
          const data = (lastEvent.hook_data?.event_data ?? lastEvent.hook_data?.raw_hook_data) as Record<string, unknown> | undefined;
          const label =
            (typeof data?.label === 'string' ? data.label : null) ??
            (typeof data?.phase === 'string' ? data.phase : null) ??
            lastEvent.event_type;
          return (
            <div
              key={top}
              className="absolute left-1 right-1 flex items-center gap-1"
              style={{ top: displayTop }}
            >
              <Icon className={`h-3 w-3 shrink-0 ${color}`} />
              <span className="truncate text-[10px] text-muted-foreground">{label}</span>
              {evts.length > 1 && (
                <span className="text-[9px] text-muted-foreground/60">{evts.length}</span>
              )}
            </div>
          );
        })}
        {displayEvents.length === 0 && workerSessionId && (
          <div className="p-2 text-[10px] text-muted-foreground/50">Waiting for trace events…</div>
        )}
      </div>
    </div>
  );
}
