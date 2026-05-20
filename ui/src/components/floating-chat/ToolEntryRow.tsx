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

  // Compact chip: a tiny pill that signals "agent is alive and doing things".
  // Visual goal is heartbeat / breadcrumb, not a primary CTA. Click expands
  // to the full per-event list, but expansion is intentionally low-affordance
  // (no chevron in the resting state — discovery is by hover).
  const headlineDetail = latest?.detail ?? '';
  return (
    <div
      data-testid="dense-tool-row"
      // Column so the expanded list drops BELOW the chip, indented slightly,
      // instead of stretching to the right and turning the chip into a giant
      // strip. `items-start` keeps the chip pill content-sized.
      className="my-0.5 flex flex-col items-start gap-1"
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        data-testid="dense-tool-row-toggle"
        aria-expanded={expanded}
        title={
          latest
            ? `${totalCount} event${totalCount === 1 ? '' : 's'} · ${latest.label}${headlineDetail ? ` · ${headlineDetail}` : ''}`
            : `${totalCount} event${totalCount === 1 ? '' : 's'}`
        }
        className={[
          'inline-flex max-w-full items-center gap-1 rounded-full border px-1.5 py-px',
          'text-[10px] leading-none text-muted-foreground/80',
          'border-sky-400/15 bg-sky-50/30 hover:border-sky-400/30 hover:text-foreground/80',
          'dark:border-sky-400/10 dark:bg-sky-950/20 dark:hover:border-sky-400/25',
          'transition-colors',
        ].join(' ')}
      >
        <OneLinerIcon kind={latest?.icon ?? 'tool'} inFlight={latest?.inFlight ?? false} />
        <span className="tabular-nums">{totalCount}</span>
        {headlineDetail && (
          <>
            <span className="opacity-30">·</span>
            <span className="max-w-[220px] truncate font-mono text-[10px] text-foreground/60">
              {headlineDetail}
            </span>
          </>
        )}
      </button>

      {expanded && (
        <ul className="ml-3 flex max-w-full flex-col gap-0.5 rounded-md border border-sky-400/15 bg-sky-50/20 px-2 py-1 dark:border-sky-400/10 dark:bg-sky-950/15">
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
  // Tiny — the chip is "it's alive" candy, not an information surface.
  const cls = 'h-2.5 w-2.5 flex-shrink-0';
  // In-flight = a TOOL_CALL has no matching TOOL_RESULT yet. Use the same
  // tool icon as the resting state and animate a soft pulse rather than a
  // spinning loader so the chip feels like a heartbeat, not "busy/loading".
  if (inFlight) return <Wrench className={`${cls} animate-pulse text-sky-500`} />;
  if (kind === 'reasoning') return <Sparkles className={`${cls} text-violet-500`} />;
  if (kind === 'error') return <AlertTriangle className={`${cls} text-red-500`} />;
  if (kind === 'status') return <Activity className={`${cls} text-amber-500`} />;
  return <Wrench className={`${cls} text-sky-500`} />;
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
        {/* In-flight = no matching TOOL_RESULT in this bucket. We show a soft
         * pulse on the same wrench icon, not a circular spinner — keeps the
         * "alive" cue consistent with the chip and avoids the false impression
         * of a stuck request when the matching result actually landed in a
         * different turn-bucket (cross-bucket pairing isn't done today). */}
        {isError ? (
          <AlertTriangle className="h-3 w-3 flex-shrink-0 text-red-500" />
        ) : (
          <Wrench
            className={`h-3 w-3 flex-shrink-0 text-sky-500${inFlight ? ' animate-pulse' : ''}`}
          />
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
  // Two-pass walk so the chip prefers a TOOL_CALL one-liner (e.g.
  // "Bash · ls -la") even when the actual last event in the buffer is a
  // hook STATUS like "PostToolUse". Hook events trail every tool call but
  // make for a poor one-line summary on the chip; the user wants the
  // command/path/url to read.
  for (let i = events.length - 1; i >= 0; i--) {
    const evt = events[i];
    if (evt.elementType !== FlowElementTypes.TOOL_CALL) continue;
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
  // No tool calls in the bucket — fall back to the latest reasoning /
  // status / error entry. The label alone is the chip detail; we never
  // dump the payload here (long JSON kills the chip layout).
  for (let i = events.length - 1; i >= 0; i--) {
    const evt = events[i];
    if (DENSE_OTHER.has(evt.elementType)) {
      const { icon, label } = describeOther(evt);
      return { icon, label, detail: label, inFlight: false };
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
