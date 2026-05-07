import {
  describeToolInput,
  describeToolName,
} from '@src/components/flowdata-renderer/ToolCallMessageComponent';
import { cn } from '@src/lib/utils';
import { FlowData, FlowElementTypes } from '@sdk';
import {
  Activity,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Loader2,
  Sparkles,
  Wrench,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { pairToolEvents, type ToolPair } from './groupTurnEvents';

interface ToolEntryRowProps {
  events: FlowData[];
}

interface OneLiner {
  icon: 'tool' | 'reasoning' | 'status' | 'error';
  label: string;
  detail: string;
  inFlight: boolean;
}

/**
 * Dense one-row summary of every non-text event in an assistant turn:
 * tool calls, reasoning, hook status, errors. Defaults to `count + latest
 * one-liner`; an expand chevron reveals every event, and individual tool
 * entries can expand again to show full args + result JSON.
 */
export function ToolEntryRow({ events }: ToolEntryRowProps) {
  const [expanded, setExpanded] = useState(false);

  const { pairs, others, orphanResults } = useMemo(() => pairToolEvents(events), [events]);
  const totalCount = pairs.length + others.length + orphanResults.length;

  const latest = useMemo<OneLiner | null>(() => describeLatest(events, pairs), [events, pairs]);

  if (totalCount === 0) return null;

  return (
    <div
      data-testid="dense-tool-row"
      className="my-1 rounded-md border border-sky-400/20 bg-sky-50/40 px-2 py-1.5 text-xs dark:border-sky-400/15 dark:bg-sky-950/20"
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 text-left"
        data-testid="dense-tool-row-toggle"
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
        )}
        <OneLinerIcon kind={latest?.icon ?? 'tool'} inFlight={latest?.inFlight ?? false} />
        <span className="font-medium tabular-nums text-muted-foreground">
          {totalCount} {totalCount === 1 ? 'event' : 'events'}
        </span>
        {latest?.label && (
          <span className="truncate text-muted-foreground">
            <span className="opacity-50">·</span> {latest.label}
            {latest.detail && (
              <>
                <span className="opacity-50"> ·</span>{' '}
                <span className="font-mono text-[11px] text-foreground/70">{latest.detail}</span>
              </>
            )}
          </span>
        )}
      </button>

      {expanded && (
        <ul className="mt-2 flex flex-col gap-1 border-t border-sky-400/15 pt-2 dark:border-sky-400/10">
          {pairs.map((pair, i) => (
            <ToolPairItem key={`pair-${i}`} pair={pair} />
          ))}
          {others.map((evt, i) => (
            <OtherEventItem key={`other-${i}`} event={evt} />
          ))}
          {orphanResults.map((evt, i) => (
            <OrphanResultItem key={`orphan-${i}`} event={evt} />
          ))}
        </ul>
      )}
    </div>
  );
}

function OneLinerIcon({ kind, inFlight }: { kind: OneLiner['icon']; inFlight: boolean }) {
  if (inFlight) {
    return <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin text-sky-500" />;
  }
  if (kind === 'reasoning') {
    return <Sparkles className="h-3.5 w-3.5 flex-shrink-0 text-violet-500" />;
  }
  if (kind === 'error') {
    return <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 text-red-500" />;
  }
  if (kind === 'status') {
    return <Activity className="h-3.5 w-3.5 flex-shrink-0 text-amber-500" />;
  }
  return <Wrench className="h-3.5 w-3.5 flex-shrink-0 text-sky-500" />;
}

function ToolPairItem({ pair }: { pair: ToolPair }) {
  const [open, setOpen] = useState(false);
  const toolName = pair.call.attributes['tool-name'] || 'Tool';
  const summary = describeToolInput(pair.call.data);
  const inFlight = pair.result === null;
  const isError = pair.result?.attributes['outcome'] === 'error';

  return (
    <li
      data-testid="tool-entry"
      data-state={inFlight ? 'running' : isError ? 'error' : 'done'}
      className="rounded border border-transparent text-[11px] hover:border-sky-400/15"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-1.5 py-0.5 text-left"
      >
        {open ? (
          <ChevronDown className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
        )}
        {inFlight ? (
          <Loader2 className="h-3 w-3 flex-shrink-0 animate-spin text-sky-500" />
        ) : isError ? (
          <AlertTriangle className="h-3 w-3 flex-shrink-0 text-red-500" />
        ) : (
          <Wrench className="h-3 w-3 flex-shrink-0 text-sky-500" />
        )}
        <span className="font-medium">{describeToolName(toolName)}</span>
        {summary && (
          <span className="truncate font-mono text-[10px] text-foreground/70">{summary}</span>
        )}
      </button>
      {open && (
        <div className="px-2 pb-1 pt-0.5">
          <PayloadBlock label="input" value={(pair.call.data as Record<string, unknown> | undefined)?.args ?? (pair.call.data as Record<string, unknown> | undefined)?.input} />
          <PayloadBlock
            label={inFlight ? 'output (running…)' : 'output'}
            value={pair.result ? (pair.result.data as Record<string, unknown> | undefined)?.content : null}
          />
        </div>
      )}
    </li>
  );
}

function OtherEventItem({ event }: { event: FlowData }) {
  const [open, setOpen] = useState(false);
  const { icon, label } = describeOther(event);
  const detail = extractText(event);

  return (
    <li
      data-testid="tool-entry"
      data-state="done"
      className="rounded border border-transparent text-[11px] hover:border-sky-400/15"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-1.5 py-0.5 text-left"
      >
        {open ? (
          <ChevronDown className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
        )}
        <OneLinerIcon kind={icon} inFlight={false} />
        <span className="font-medium">{label}</span>
        {detail && (
          <span className="truncate font-mono text-[10px] text-foreground/70">{detail}</span>
        )}
      </button>
      {open && (
        <div className="px-2 pb-1 pt-0.5">
          <PayloadBlock label="data" value={event.data} />
          {Object.keys(event.attributes).length > 0 && (
            <PayloadBlock label="attributes" value={event.attributes} />
          )}
        </div>
      )}
    </li>
  );
}

function OrphanResultItem({ event }: { event: FlowData }) {
  return (
    <li
      data-testid="tool-entry"
      data-state="done"
      className={cn('px-1.5 py-0.5 text-[11px] text-muted-foreground')}
    >
      <span className="opacity-60">tool result (no matching call):</span>{' '}
      <span className="truncate font-mono text-[10px]">{extractText(event)}</span>
    </li>
  );
}

function PayloadBlock({ label, value }: { label: string; value: unknown }) {
  if (value === null || value === undefined) return null;
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  if (!text.trim()) return null;
  return (
    <div className="mt-1">
      <div className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <pre className="mt-0.5 max-h-48 overflow-auto rounded bg-muted/40 px-2 py-1 font-mono text-[10px] leading-snug">
        {text}
      </pre>
    </div>
  );
}

function describeLatest(events: FlowData[], pairs: ToolPair[]): OneLiner | null {
  if (events.length === 0) return null;
  // Prefer the latest tool call so the row reads like "Read · src/foo.ts".
  for (let i = events.length - 1; i >= 0; i--) {
    const evt = events[i];
    if (evt.elementType === FlowElementTypes.TOOL_CALL) {
      const id = (evt.data as { tool_call_id?: string } | undefined)?.tool_call_id;
      const matchingPair = pairs.find((p) => {
        const pid = (p.call.data as { tool_call_id?: string } | undefined)?.tool_call_id;
        return pid && pid === id;
      });
      const inFlight = !!matchingPair && matchingPair.result === null;
      const toolName = evt.attributes['tool-name'] || 'Tool';
      return {
        icon: 'tool',
        label: describeToolName(toolName),
        detail: describeToolInput(evt.data),
        inFlight,
      };
    }
    if (evt.elementType === FlowElementTypes.TOOL_RESULT) continue; // skip — pair'd
    if (DENSE_OTHER.has(evt.elementType)) {
      const { icon, label } = describeOther(evt);
      return { icon, label, detail: extractText(evt), inFlight: false };
    }
  }
  return null;
}

const DENSE_OTHER = new Set<string>([
  FlowElementTypes.REASONING,
  FlowElementTypes.STATUS,
  FlowElementTypes.ERROR,
]);

function describeOther(event: FlowData): { icon: OneLiner['icon']; label: string } {
  if (event.elementType === FlowElementTypes.REASONING) return { icon: 'reasoning', label: 'thinking' };
  if (event.elementType === FlowElementTypes.ERROR) return { icon: 'error', label: 'error' };
  // STATUS — surface the subtype if present (e.g. "PreToolUse")
  const subtype = event.attributes['subtype'];
  return { icon: 'status', label: subtype || 'status' };
}

function extractText(event: FlowData): string {
  // Hook events from the sniffer carry a pre-built one-liner.
  const msg = event.attributes['hook-message'] || event.attributes['tool-input-summary'];
  if (msg) return String(msg).slice(0, 120);
  if (typeof event.content === 'string' && event.content) return event.content.slice(0, 120);
  if (typeof event.data === 'string') return event.data.slice(0, 120);
  return '';
}
