import { AgenticProcess, FSRef, dataContext } from '@sdk';
import { CheckCircle2, Circle, MinusCircle, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';

import { CollapsibleSection } from './CollapsibleSection';

interface TraceEvent {
  kind: string;
  file?: string;
  line?: number;
  status?: 'enter' | 'done' | 'skip' | 'error';
  message?: string;
  ts?: string;
}

interface TraceStep {
  line: number;
  status: 'enter' | 'done' | 'skip' | 'error' | 'unknown';
  enterTs?: string;
  doneTs?: string;
  durationMs?: number;
}

function statusIcon(status: TraceStep['status']) {
  if (status === 'done') return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />;
  if (status === 'error') return <XCircle className="h-3.5 w-3.5 text-destructive" />;
  if (status === 'skip') return <MinusCircle className="h-3.5 w-3.5 text-muted-foreground" />;
  return <Circle className="h-3.5 w-3.5 text-muted-foreground/50" />;
}

function fmtDuration(ms: number | undefined): string {
  if (ms == null) return '';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function reduceEvents(events: TraceEvent[]): TraceStep[] {
  const byLine = new Map<number, TraceStep>();
  for (const ev of events) {
    if (ev.kind !== 'step' || ev.line == null) continue;
    const existing = byLine.get(ev.line) ?? { line: ev.line, status: 'unknown' as const };
    if (ev.status === 'enter') {
      existing.enterTs = ev.ts;
      if (existing.status === 'unknown') existing.status = 'enter';
    } else if (ev.status === 'done') {
      existing.doneTs = ev.ts;
      existing.status = 'done';
    } else if (ev.status === 'error') {
      existing.doneTs = ev.ts;
      existing.status = 'error';
    } else if (ev.status === 'skip') {
      existing.status = 'skip';
    }
    if (existing.enterTs && existing.doneTs) {
      existing.durationMs = new Date(existing.doneTs).getTime() - new Date(existing.enterTs).getTime();
    }
    byLine.set(ev.line, existing);
  }
  return [...byLine.values()].sort((a, b) => a.line - b.line);
}

export function TraceSection({ process }: { process: AgenticProcess }) {
  const [events, setEvents] = useState<TraceEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const out = process.output_folder;
    const computeNodeId = dataContext.computeNodeTypeId;
    if (!out?.path || !computeNodeId) {
      setEvents([]);
      return;
    }
    const trace = new FSRef(`${out.path}/workflow.trace.jsonl`, computeNodeId);
    void trace
      .read()
      .then((text) => {
        if (cancelled) return;
        const parsed = text
          .split(/\r?\n/)
          .filter((l) => l.trim())
          .map((l) => {
            try {
              return JSON.parse(l) as TraceEvent;
            } catch {
              return null;
            }
          })
          .filter((e): e is TraceEvent => !!e);
        setEvents(parsed);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setEvents([]);
      });
    return () => {
      cancelled = true;
    };
  }, [process.id, process.output_folder?.path]);

  if (events === null) {
    return (
      <CollapsibleSection title="Trace" testId="learning-trace-section">
        <div className="text-xs text-muted-foreground">Loading…</div>
      </CollapsibleSection>
    );
  }
  if (error) {
    return (
      <CollapsibleSection title="Trace" testId="learning-trace-section">
        <div className="text-xs text-destructive">No trace: {error}</div>
      </CollapsibleSection>
    );
  }
  const steps = reduceEvents(events);
  if (steps.length === 0) {
    return (
      <CollapsibleSection title="Trace" testId="learning-trace-section">
        <div className="text-xs text-muted-foreground">
          No <code>workflow.trace.jsonl</code> events. The runner may not have used the
          <code> flow workflow report</code> CLI.
        </div>
      </CollapsibleSection>
    );
  }
  const total = steps.length;
  const passed = steps.filter((s) => s.status === 'done').length;
  const failed = steps.filter((s) => s.status === 'error').length;
  const summary = failed > 0 ? `${passed}/${total} passed · ${failed} failed` : `${passed}/${total} passed`;
  return (
    <CollapsibleSection title="Trace" hint={summary} testId="learning-trace-section">
      <ol className="space-y-1 text-xs">
        {steps.map((s) => (
          <li key={s.line} className="flex items-center gap-2">
            {statusIcon(s.status)}
            <span className="font-mono text-muted-foreground">L{s.line}</span>
            <span className="flex-1 truncate text-foreground">{s.status}</span>
            <span className="font-mono text-[10px] text-muted-foreground">{fmtDuration(s.durationMs)}</span>
          </li>
        ))}
      </ol>
    </CollapsibleSection>
  );
}
