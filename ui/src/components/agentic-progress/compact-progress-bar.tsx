import { ProcessorState } from '@sdk';
import { Button } from '@src/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { cn } from '@src/lib/utils';
import { Maximize2 } from 'lucide-react';
import { StatusIndicator } from './shared/status-indicator';
import { useAgenticProgressInfo } from './hooks/use-agentic-process-state';

interface CompactProgressBarProps {
  state: ProcessorState;
  filePath?: string;
  onExpand?: () => void;
  flowDataCount?: number;
  className?: string;
  elapsedTime?: string | null;
  statusMessage?: string | null;
  activityLabel?: string | null;
  tokenUsage?: { input: number; output: number } | null;
}

/**
 * Compact progress bar showing:
 * Row 1: [StatusIcon] [ActivityLabel] ... [FileName] [ProgressInfo] [ElapsedTime] [Tokens] [ExpandButton]
 * Row 2: [StatusMessage with tooltip]
 */
export function CompactProgressBar({
  state,
  filePath,
  onExpand,
  flowDataCount = 0,
  className,
  elapsedTime,
  statusMessage,
  activityLabel,
  tokenUsage,
}: CompactProgressBarProps) {
  const info = useAgenticProgressInfo(state);
  const fileName = filePath ? getFileName(filePath) : 'Instruction';

  const showStatusRow = !!statusMessage;

  return (
    <div
      className={cn(
        'flex flex-col rounded-lg border bg-card px-3 py-2',
        info.isError && 'border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/30',
        info.isComplete && 'border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950/30',
        className,
      )}
    >
      {/* Row 1: Status, activity label, spacer, filename, progress, elapsed time, tokens, expand */}
      <div className="flex items-center gap-3">
        {/* Status Icon — hide label when activity label is shown */}
        <StatusIndicator status={state.status} showLabel={!activityLabel} size="md" />

        {/* Activity Label */}
        {activityLabel && (info.isRunning || info.isPaused) && (
          <span className="text-sm font-medium text-blue-500">{activityLabel}</span>
        )}

        {/* Spacer pushes remaining items to the right */}
        <div className="flex-1" />

        {/* File Name */}
        <span className="min-w-0 truncate font-mono text-sm text-foreground">{fileName}</span>

        {/* Progress Info */}
        <div className="flex shrink-0 items-center gap-2 text-sm text-muted-foreground">
          {renderProgressInfo(state, info)}
          {flowDataCount > 0 && (
            <span className="flex items-center gap-1">
              <span className="text-muted-foreground/50">·</span>
              {flowDataCount} output{flowDataCount !== 1 ? 's' : ''}
            </span>
          )}
        </div>

        {/* Elapsed Time */}
        {elapsedTime && <span className="shrink-0 font-mono text-xs text-muted-foreground">{elapsedTime}</span>}

        {/* Token Usage */}
        {tokenUsage && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="shrink-0 font-mono text-xs text-muted-foreground">
                · {formatTokenCount(tokenUsage.input + tokenUsage.output)} tokens
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <div className="text-xs">
                <div>Input: {tokenUsage.input.toLocaleString()}</div>
                <div>Output: {tokenUsage.output.toLocaleString()}</div>
              </div>
            </TooltipContent>
          </Tooltip>
        )}

        {/* Expand Button */}
        {onExpand && (
          <Button variant="ghost" size="sm" onClick={onExpand} className="h-7 gap-1 px-2 text-xs">
            <Maximize2 className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Expand</span>
          </Button>
        )}
      </div>

      {/* Row 2: Live status message with tooltip for full text */}
      {showStatusRow && (
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="mt-1 truncate text-xs italic text-muted-foreground/70">{statusMessage}</div>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-[80vw] whitespace-pre-wrap break-words">
            {statusMessage}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

function renderProgressInfo(state: ProcessorState, info: ReturnType<typeof useAgenticProgressInfo>) {
  const parts: React.ReactNode[] = [];

  // Step progress
  if (info.isRunning || info.isPaused) {
    parts.push(
      <span key="step">
        Step {info.currentStep}
        {info.totalSteps ? `/${info.totalSteps}` : ''}
      </span>,
    );
  }

  // Loop info
  if (info.loopInfo && (info.isRunning || info.isPaused)) {
    parts.push(
      <span key="loop" className="flex items-center gap-1">
        <span className="text-muted-foreground/50">·</span>
        Loop {info.loopInfo.current}/{info.loopInfo.total}
      </span>,
    );
  }

  // Completed steps
  if (info.isComplete) {
    parts.push(
      <span key="complete">
        {info.currentStep} step{info.currentStep !== 1 ? 's' : ''} completed
      </span>,
    );
  }

  // Error message (truncated)
  if (info.isError && state.error) {
    parts.push(
      <span key="error" className="truncate text-red-600 dark:text-red-400">
        {truncate(state.error, 40)}
      </span>,
    );
  }

  // Waiting for input
  if (state.waitingForInput) {
    parts.push(
      <span key="waiting" className="text-yellow-600 dark:text-yellow-400">
        Waiting for input
      </span>,
    );
  }

  // Idle state
  if (info.isIdle && parts.length === 0) {
    parts.push(
      <span key="idle" className="text-muted-foreground">
        Ready
      </span>,
    );
  }

  return parts;
}

function getFileName(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toString();
}
