import { Button } from '@src/components/ui/button';
import { cn } from '@src/lib/utils';
import { AgenticProcess } from '@sdk';
import { Loader2, Sparkles, Wand2, XCircle } from 'lucide-react';
import { useState } from 'react';

import { useProcessArtifactState } from './useProcessArtifactState';

interface LearningRunRowProps {
  process: AgenticProcess;
  isActive: boolean;
  isJobRunning: boolean;
  learningLog: string | null;
  refreshKey: number;
  onSelect: () => void;
  onAnalyze: () => Promise<void> | void;
  onImprove: () => Promise<void> | void;
}

function formatTime(d: Date | string | null | undefined): string {
  if (!d) return '';
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date();
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  if (sameDay) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function LearningRunRow({
  process,
  isActive,
  isJobRunning,
  learningLog,
  refreshKey,
  onSelect,
  onAnalyze,
  onImprove,
}: LearningRunRowProps) {
  const { hasTrace, hasAnalysis, mentionedInLog, isLoading } = useProcessArtifactState(process, learningLog, refreshKey);
  const [busy, setBusy] = useState(false);

  const status = String(process.status ?? '').toLowerCase();
  const isFailed = status === 'failed';

  const action: 'analyze' | 'improve' | 'reimprove' | 'none' = !hasTrace
    ? 'none'
    : !hasAnalysis
      ? 'analyze'
      : !mentionedInLog
        ? 'improve'
        : 'reimprove';

  const handle = async () => {
    if (busy || isJobRunning) return;
    setBusy(true);
    try {
      if (action === 'analyze') {
        await onAnalyze();
      } else {
        await onImprove();
      }
    } finally {
      setBusy(false);
    }
  };

  const ActionIcon = action === 'analyze' ? Sparkles : Wand2;
  const actionLabel = action === 'analyze' ? 'Analyze' : action === 'improve' ? 'Improve' : 'Re-improve';

  const startedAtRaw = (process as unknown as { created_date?: Date | string }).created_date;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      data-testid="learning-run-row"
      data-active={isActive ? 'true' : 'false'}
      data-process-id={process.id}
      className={cn(
        'flex w-full cursor-pointer items-center gap-2 rounded-md border border-transparent px-2.5 py-2 text-left transition-colors hover:bg-muted/40',
        isActive && 'border-border bg-muted/40 ring-1 ring-primary/20',
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-xs font-medium tabular-nums text-foreground">{formatTime(startedAtRaw)}</span>
          <span className={cn('text-[10px] uppercase tracking-wide', isFailed ? 'text-destructive' : 'text-muted-foreground')}>
            {status || 'unknown'}
          </span>
        </div>
        <div className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
          {isFailed && <XCircle className="h-3 w-3 text-destructive" />}
          {!hasTrace && !isLoading && <span>no trace</span>}
          {hasTrace && !hasAnalysis && <span>not analyzed</span>}
          {hasAnalysis && !mentionedInLog && <span>not learned</span>}
          {mentionedInLog && <span>learned</span>}
        </div>
      </div>
      {action !== 'none' && (
        <Button
          size="sm"
          variant={action === 'reimprove' ? 'outline' : 'default'}
          disabled={busy || isJobRunning}
          onClick={(e) => {
            e.stopPropagation();
            void handle();
          }}
          data-testid={`learning-run-action-${action}`}
        >
          {busy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <ActionIcon className="mr-1 h-3 w-3" />}
          {actionLabel}
        </Button>
      )}
    </div>
  );
}
