import { pickProcessIcon } from '@src/components/icons/process-icons';
import { Button } from '@src/components/ui/button';
import { Tooltip, TooltipTrigger, TooltipContent } from '@src/components/ui/tooltip';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { cn } from '@src/lib/utils';
import { AgenticProcess } from '@sdk';
import { FileText, Loader2, Sparkles, Terminal, Wand2 } from 'lucide-react';
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
  const { navigation } = useDockNavigation();
  const { hasTrace, hasAnalysis, mentionedInLog } = useProcessArtifactState(process, learningLog, refreshKey);
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

  const handleAction = async () => {
    if (busy || isJobRunning || action === 'none') return;
    setBusy(true);
    try {
      if (action === 'analyze') await onAnalyze();
      else await onImprove();
    } finally {
      setBusy(false);
    }
  };

  const handleOpenTranscript = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigation.openDock(process.transcriptDockPointer);
  };
  const handleOpenTerminal = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigation.openDock(process.terminalDockPointer);
  };

  const ProcIcon = pickProcessIcon(process.icon);
  const ActionIcon = action === 'analyze' ? Sparkles : Wand2;
  const actionLabel =
    action === 'analyze' ? 'Analyze' : action === 'improve' ? 'Improve' : 'Re-improve';
  const actionDescription =
    action === 'analyze'
      ? 'Run the session_analysis skill on this run to identify issues per step.'
      : action === 'improve'
        ? 'Run the workflow_learning skill so the next runner inherits these lessons.'
        : 'Re-run the learner with updated memory and a fresh attempt-counter.';

  const stateLabel =
    !hasTrace ? 'no trace' : !hasAnalysis ? 'not analyzed' : !mentionedInLog ? 'not learned' : 'learned';

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
        'flex w-full cursor-pointer items-center gap-2 rounded-md border border-transparent px-2 py-1.5 transition-colors hover:bg-muted/40',
        isActive && 'border-border bg-muted/40 ring-1 ring-primary/20',
      )}
    >
      <ProcIcon className="h-4 w-4 shrink-0 text-muted-foreground" />

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className="text-xs font-medium tabular-nums text-foreground">{formatTime(startedAtRaw)}</span>
          <span className={cn('text-[10px] uppercase tracking-wide', isFailed ? 'text-destructive' : 'text-muted-foreground')}>
            {status || 'unknown'}
          </span>
        </div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">{stateLabel}</div>
      </div>

      {action !== 'none' && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant={action === 'reimprove' ? 'outline' : 'default'}
              size="icon"
              className="flex-shrink-0"
              disabled={busy || isJobRunning}
              onClick={(e) => {
                e.stopPropagation();
                void handleAction();
              }}
              data-testid={`learning-run-action-${action}`}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ActionIcon className="h-4 w-4" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">
            <div className="font-medium">{actionLabel}</div>
            <div className="mt-0.5 max-w-[240px] whitespace-normal text-[10px] opacity-80">{actionDescription}</div>
          </TooltipContent>
        </Tooltip>
      )}

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 flex-shrink-0"
            onClick={handleOpenTranscript}
            data-testid="learning-run-transcript"
          >
            <FileText className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">
          <div className="font-medium">Open transcript</div>
          <div className="mt-0.5 max-w-[220px] whitespace-normal text-[10px] opacity-80">
            Read-only view of the agent's prior turns and tool calls.
          </div>
          <div className="mt-1 font-mono text-[10px] opacity-60">{process.id.slice(0, 8)}</div>
        </TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 flex-shrink-0"
            onClick={handleOpenTerminal}
            data-testid="learning-run-terminal"
          >
            <Terminal className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">
          <div className="font-medium">Open terminal</div>
          <div className="mt-0.5 max-w-[220px] whitespace-normal text-[10px] opacity-80">
            Attach to (or relaunch) the live PTY for this process.
          </div>
          <div className="mt-1 font-mono text-[10px] opacity-60">{process.id.slice(0, 8)}</div>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
