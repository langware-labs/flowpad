import { ProcessorStatus, isProcessorRunning } from '@sdk';
import { Button } from '@src/components/ui/button';
import { cn } from '@src/lib/utils';
import { Maximize2 } from 'lucide-react';
import { StatusIndicator } from './shared/status-indicator';

interface CompactProgressBarProps {
  status: ProcessorStatus;
  filePath?: string;
  onExpand?: () => void;
  flowDataCount?: number;
  className?: string;
  elapsedTime?: string | null;
  statusMessage?: string | null;
  activityLabel?: string | null;
  tokenUsage?: { input: number; output: number } | null;
}

export function CompactProgressBar({
  status,
  filePath,
  onExpand,
  flowDataCount = 0,
  className,
  elapsedTime,
  activityLabel,
  tokenUsage,
}: CompactProgressBarProps) {
  const isRunning = isProcessorRunning(status);
  const isComplete = status === ProcessorStatus.COMPLETE;
  const isError = status === ProcessorStatus.ERROR;
  const fileName = filePath ? getFileName(filePath) : 'Instruction';

  return (
    <div
      className={cn(
        'flex flex-col rounded-lg border bg-card px-3 py-2',
        isError && 'border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/30',
        isComplete && 'border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950/30',
        className,
      )}
    >
      <div className="flex items-center gap-3">
        <StatusIndicator status={status} showLabel={!activityLabel} size="md" />

        {activityLabel && isRunning && (
          <span className="text-sm font-medium text-blue-500">{activityLabel}</span>
        )}

        <div className="flex-1" />

        <span className="min-w-0 truncate font-mono text-sm text-foreground">{fileName}</span>

        <div className="flex shrink-0 items-center gap-2 text-sm text-muted-foreground">
          {isComplete && <span>Complete</span>}
          {isError && <span className="text-red-600 dark:text-red-400">Error</span>}
          {!isComplete && !isError && isRunning && <span>Running…</span>}
          {flowDataCount > 0 && (
            <span className="flex items-center gap-1">
              <span className="text-muted-foreground/50">·</span>
              {flowDataCount} output{flowDataCount !== 1 ? 's' : ''}
            </span>
          )}
        </div>

        {elapsedTime && <span className="shrink-0 font-mono text-xs text-muted-foreground">{elapsedTime}</span>}

        {tokenUsage && (
          <span className="shrink-0 font-mono text-xs text-muted-foreground">
            · {formatTokenCount(tokenUsage.input + tokenUsage.output)} tokens
          </span>
        )}

        {onExpand && (
          <Button variant="ghost" size="sm" onClick={onExpand} className="h-7 gap-1 px-2 text-xs">
            <Maximize2 className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Expand</span>
          </Button>
        )}
      </div>
    </div>
  );
}

function getFileName(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toString();
}
