/**
 * Workflow-level learning.log.md pane — collapsible.
 *
 * Each entry is parsed into a structured card: timestamp · attempt # ·
 * Process chip · Issue / Fix bullets. The raw body is still accessible
 * via "Show raw" for completeness.
 *
 * Pure render: structured entries from `reduceLearningLog` (in data/).
 */

import { MarkdownView } from '@src/components/markdown-view';
import { cn } from '@src/lib/utils';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Hash,
  History,
  Wrench,
} from 'lucide-react';
import { useState } from 'react';

import type { LearningLogArtifact, LearningLogEntry } from '../data/types';

interface PastAttemptsPaneProps {
  learningLog?: LearningLogArtifact;
  defaultOpen?: boolean;
}

function formatHeading(raw: string): { date: string; time?: string } {
  const isoMatch = raw.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}):\d{2}Z?$/);
  if (isoMatch) {
    const [, date, time] = isoMatch;
    return { date, time };
  }
  return { date: raw };
}

export function PastAttemptsPane({
  learningLog,
  defaultOpen = false,
}: PastAttemptsPaneProps) {
  const [open, setOpen] = useState(defaultOpen);
  const count = learningLog?.entries.length ?? 0;
  if (count === 0) return null;
  return (
    <section data-testid="past-attempts-pane" className="border-b bg-background">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex w-full items-center gap-2 px-4 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/40',
        )}
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <History className="h-3.5 w-3.5" />
        <span className="font-medium uppercase tracking-wide">Past attempts</span>
        <span className="ml-1 rounded-sm bg-muted px-1 py-px text-[10px] tabular-nums">
          {count}
        </span>
      </button>
      {open && (
        <ol className="max-h-[50vh] space-y-2 overflow-y-auto border-t bg-muted/30 p-3">
          {learningLog!.entries.map((entry, i) => (
            <AttemptCard key={i} entry={entry} />
          ))}
        </ol>
      )}
    </section>
  );
}

function AttemptCard({ entry }: { entry: LearningLogEntry }) {
  const [showRaw, setShowRaw] = useState(false);
  const { date, time } = formatHeading(entry.heading);
  const structured = !!(entry.issue || entry.fix);
  return (
    <li
      data-testid="past-attempt-entry"
      className="rounded-md border bg-background p-3 shadow-sm"
    >
      <header className="flex items-center gap-2 text-[11px]">
        {entry.attemptNumber !== undefined && (
          <span className="inline-flex items-center gap-0.5 rounded-sm bg-primary/10 px-1.5 py-0.5 font-mono font-medium text-primary">
            <Hash className="h-2.5 w-2.5" />
            {entry.attemptNumber}
          </span>
        )}
        <span className="font-medium text-foreground tabular-nums">{date}</span>
        {time && (
          <span className="text-muted-foreground tabular-nums">{time}</span>
        )}
        {entry.processId && (
          <code
            className="ml-auto rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
            title={entry.processId}
          >
            {entry.processId.slice(0, 8)}
          </code>
        )}
      </header>

      {structured ? (
        <div className="mt-2 space-y-1.5 text-sm leading-snug">
          {entry.issue && (
            <div className="flex items-start gap-1.5">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
              <p>
                <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Issue
                </span>
                <br />
                {entry.issue}
              </p>
            </div>
          )}
          {entry.fix && (
            <div className="flex items-start gap-1.5">
              <Wrench className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
              <p>
                <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Fix
                </span>
                <br />
                {entry.fix}
              </p>
            </div>
          )}
        </div>
      ) : (
        <div className="prose prose-sm mt-2 max-w-none dark:prose-invert">
          <MarkdownView value={entry.body} compact />
        </div>
      )}

      {structured && (
        <button
          type="button"
          onClick={() => setShowRaw((s) => !s)}
          className="mt-2 text-[10px] text-muted-foreground hover:text-foreground"
        >
          {showRaw ? '− hide raw' : '+ show raw'}
        </button>
      )}
      {structured && showRaw && (
        <pre className="mt-1.5 whitespace-pre-wrap break-words rounded-sm bg-muted/60 p-2 text-[11px] leading-relaxed text-muted-foreground">
          {entry.body}
        </pre>
      )}
    </li>
  );
}
