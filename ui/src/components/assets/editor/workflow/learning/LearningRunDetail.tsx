import { AgenticProcess } from '@sdk';

import { AnalysisSection } from './sections/AnalysisSection';
import { FeedbackSection } from './sections/FeedbackSection';
import { LogEntrySection } from './sections/LogEntrySection';
import { MemorySection } from './sections/MemorySection';
import { TraceSection } from './sections/TraceSection';

interface LearningRunDetailProps {
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

export function LearningRunDetail({ process, memory, feedback, learningLog }: LearningRunDetailProps) {
  const status = String(process.status ?? '').toLowerCase();
  const startedRaw = (process as unknown as { created_date?: Date | string }).created_date;
  const lastUpdatedRaw = (process as unknown as { last_updated_at?: Date | string; updated_date?: Date | string }).last_updated_at
    ?? (process as unknown as { updated_date?: Date | string }).updated_date;
  return (
    <div className="flex h-full flex-col overflow-hidden" data-testid="learning-run-detail">
      <header className="flex-shrink-0 border-b px-4 py-3">
        <div className="flex items-baseline justify-between gap-2">
          <div>
            <div className="text-sm font-semibold text-foreground">Run · {process.id.slice(0, 8)}</div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              {status} · {fmtElapsed(startedRaw, lastUpdatedRaw) || '—'}
              {startedRaw ? ` · started ${new Date(startedRaw as string | Date).toLocaleString()}` : ''}
            </div>
          </div>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <TraceSection process={process} />
        <AnalysisSection process={process} />
        <MemorySection memory={memory} />
        <LogEntrySection learningLog={learningLog} processId={process.id} />
        <FeedbackSection feedback={feedback} />
      </div>
    </div>
  );
}
