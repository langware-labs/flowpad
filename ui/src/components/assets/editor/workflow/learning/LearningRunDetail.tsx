import { TooltipProvider } from '@src/components/ui/tooltip';
import { AgenticProcess, Workflow } from '@sdk';

import { AnnotatedTraceView } from './annotated-trace/AnnotatedTraceView';
import { FeedbackBanner } from './sections/FeedbackBanner';
import { MemoryBand } from './sections/MemoryBand';
import { PastAttemptsBand } from './sections/PastAttemptsBand';

interface LearningRunDetailProps {
  workflow: Workflow;
  process: AgenticProcess;
  memory: string | null;
  feedback: string | null;
  learningLog: string | null;
}

function fmtElapsed(start: unknown, end: unknown): string {
  const t0 = start instanceof Date ? start.getTime() : typeof start === 'string' ? new Date(start).getTime() : 0;
  const t1 = end instanceof Date ? end.getTime() : typeof end === 'string' ? new Date(end).getTime() : Date.now();
  if (!t0 || !t1 || t1 <= t0) return '';
  const ms = t1 - t0;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * The detail pane sticky stack (top-down):
 *   1. Run header               — top: 0
 *   2. Feedback banner (if any) — top: HEADER_H
 *   3. Memory band              — top: HEADER_H + (FEEDBACK_H | 0)
 *   4. Past-attempts band       — top: HEADER_H + (FEEDBACK_H | 0) + MEMORY_H
 *   5. AnchoredSurface          — scrolls beneath
 *
 * Heights are computed from CSS classes (consistent across the app):
 *   HEADER_H ≈ 52px (matches editor header height)
 *   BAND_H   ≈ 32px (each)
 *   FEEDBACK_H ≈ 32px (collapsed) — present only when surrender exists
 */
const HEADER_H = 52;
const BAND_H = 32;

export function LearningRunDetail({ workflow, process, memory, feedback, learningLog }: LearningRunDetailProps) {
  const status = String(process.status ?? '').toLowerCase();
  const startedRaw = (process as unknown as { created_date?: Date | string }).created_date;
  const lastUpdatedRaw =
    (process as unknown as { last_updated_at?: Date | string; updated_date?: Date | string }).last_updated_at
    ?? (process as unknown as { updated_date?: Date | string }).updated_date;

  const hasFeedback = !!feedback?.trim();
  const feedbackTop = HEADER_H;
  const memoryTop = HEADER_H + (hasFeedback ? BAND_H : 0);
  const pastTop = memoryTop + BAND_H;

  return (
    <TooltipProvider delayDuration={200}>
      <div className="relative h-full overflow-y-auto" data-testid="learning-run-detail">
        <header
          className="z-40 border-b bg-background px-4 py-3"
          style={{ position: 'sticky', top: 0, height: HEADER_H }}
        >
          <div className="text-sm font-semibold text-foreground">Run · {process.id.slice(0, 8)}</div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            {status} · {fmtElapsed(startedRaw, lastUpdatedRaw) || '—'}
            {startedRaw ? ` · started ${new Date(startedRaw as string | Date).toLocaleString()}` : ''}
          </div>
        </header>

        <FeedbackBanner feedback={feedback} stickyTop={feedbackTop} />
        <MemoryBand memory={memory} stickyTop={memoryTop} />
        <PastAttemptsBand learningLog={learningLog} stickyTop={pastTop} />

        <AnnotatedTraceView workflow={workflow} process={process} />
      </div>
    </TooltipProvider>
  );
}
