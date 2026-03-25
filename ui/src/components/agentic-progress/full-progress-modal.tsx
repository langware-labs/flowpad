import { FlowData, ProcessorState } from '@sdk';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Progress } from '@src/components/ui/progress';
import { ScrollArea } from '@src/components/ui/scroll-area';
import { cn } from '@src/lib/utils';
import { FileText, AlertCircle } from 'lucide-react';
import { StatusBadge } from './shared/status-indicator';
import { StackFrameList } from './shared/stack-frame-list';
import { VariablesInspector } from './shared/variables-inspector';
import { LoopProgress } from './shared/loop-progress';
import { useAgenticProgressInfo } from './hooks/use-agentic-process-state';

interface FullProgressModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  state: ProcessorState;
  filePath?: string;
  flowData?: readonly FlowData[];
  flowDataCount?: number;
  className?: string;
}

/**
 * Full modal view with detailed execution information:
 * - Header with file path and status badge
 * - Progress overview
 * - Stack trace visualization
 * - Loop progress (if in 'each' instruction)
 * - Variables inspector (global and local)
 * - FlowData outputs summary
 * - Error details (if error state)
 */
export function FullProgressModal({
  open,
  onOpenChange,
  state,
  filePath,
  flowData = [],
  flowDataCount = 0,
  className,
}: FullProgressModalProps) {
  const info = useAgenticProgressInfo(state);
  const fileName = filePath ? getFileName(filePath) : 'Instruction';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn('max-w-2xl', className)}>
        <DialogHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <div className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-muted-foreground" />
            <DialogTitle className="font-mono text-base">{fileName}</DialogTitle>
          </div>
          <StatusBadge status={state.status} />
        </DialogHeader>

        <ScrollArea className="max-h-[70vh]">
          <div className="space-y-4 pr-4">
            {/* Progress Overview */}
            <ProgressOverview state={state} info={info} />

            {/* Active Loop Progress */}
            {info.loopInfo && (
              <div className="rounded-lg border bg-muted/30 p-3">
                <LoopProgress
                  current={info.loopInfo.current}
                  total={info.loopInfo.total}
                  name={info.loopInfo.name}
                  variant="bar"
                />
              </div>
            )}

            {/* Stack Trace */}
            {state.stack.length > 0 && (
              <div className="rounded-lg border p-3">
                <StackFrameList stack={state.stack} />
              </div>
            )}

            {/* Global Variables */}
            {Object.keys(state.variables).length > 0 && (
              <div className="rounded-lg border p-3">
                <VariablesInspector variables={state.variables} title="Variables" defaultOpen />
              </div>
            )}

            {/* FlowData Outputs */}
            {flowDataCount > 0 && (
              <div className="rounded-lg border p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-sm font-medium">Outputs</span>
                  <span className="text-xs text-muted-foreground">{flowDataCount} items</span>
                </div>
                <div className="space-y-1">
                  {flowData.slice(-5).map((fd, i) => (
                    <div key={i} className="flex items-center gap-2 rounded bg-muted/50 px-2 py-1 text-xs">
                      <span className="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-primary">
                        {fd.elementType}
                      </span>
                      <span className="truncate text-muted-foreground">
                        {typeof fd.data === 'string'
                          ? fd.data.substring(0, 50) + (fd.data.length > 50 ? '...' : '')
                          : '[object]'}
                      </span>
                    </div>
                  ))}
                  {flowDataCount > 5 && (
                    <div className="text-center text-xs text-muted-foreground">... and {flowDataCount - 5} more</div>
                  )}
                </div>
              </div>
            )}

            {/* Error Details */}
            {info.isError && state.error && <ErrorDetails error={state.error} />}

            {/* Waiting for Input */}
            {state.waitingForInput && (
              <div className="flex items-center gap-2 rounded-lg border border-yellow-200 bg-yellow-50 p-3 dark:border-yellow-900 dark:bg-yellow-950/30">
                <div className="h-2 w-2 animate-pulse rounded-full bg-yellow-500" />
                <span className="text-sm text-yellow-700 dark:text-yellow-400">
                  Waiting for user input
                  {state.inputId && (
                    <span className="ml-1 font-mono text-xs text-muted-foreground">(id: {state.inputId})</span>
                  )}
                </span>
              </div>
            )}

            {/* Debug Mode Indicator */}
            {state.debug.enabled && (
              <div className="rounded-lg border border-purple-200 bg-purple-50 p-3 dark:border-purple-900 dark:bg-purple-950/30">
                <div className="flex items-center gap-2 text-sm text-purple-700 dark:text-purple-400">
                  <span className="font-medium">Debug Mode</span>
                  {state.debug.stepMode && (
                    <span className="rounded bg-purple-200 px-1.5 py-0.5 text-xs dark:bg-purple-900">
                      Step: {state.debug.stepMode}
                    </span>
                  )}
                </div>
                {state.debug.breakpoints.length > 0 && (
                  <div className="mt-1 text-xs text-muted-foreground">
                    Breakpoints: {state.debug.breakpoints.join(', ')}
                  </div>
                )}
              </div>
            )}

            {/* File Path */}
            {filePath && (
              <div className="text-xs text-muted-foreground">
                <span className="text-muted-foreground/60">Path: </span>
                <span className="font-mono">{filePath}</span>
              </div>
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

interface ProgressOverviewProps {
  state: ProcessorState;
  info: ReturnType<typeof useAgenticProgressInfo>;
}

function ProgressOverview({ state: _state, info }: ProgressOverviewProps) {
  // Calculate approximate progress (if we had total steps)
  // For now, show step number without percentage
  const hasProgress = info.isRunning || info.isPaused || info.isComplete;

  return (
    <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">
          {info.isComplete ? 'Completed' : info.isError ? 'Failed at' : 'Current'} Step
        </span>
        <span className="font-medium">
          {info.currentStep}
          {info.totalSteps && <span className="text-muted-foreground"> of {info.totalSteps}</span>}
        </span>
      </div>
      {info.totalSteps && hasProgress && (
        <Progress
          value={(info.currentStep / info.totalSteps) * 100}
          className={cn('h-2', info.isError && '[&>div]:bg-red-500', info.isComplete && '[&>div]:bg-green-500')}
        />
      )}
      {info.stackDepth > 0 && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>Call Stack Depth</span>
          <span>{info.stackDepth}</span>
        </div>
      )}
    </div>
  );
}

function ErrorDetails({ error }: { error: string }) {
  return (
    <div className="space-y-2 rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-900 dark:bg-red-950/30">
      <div className="flex items-center gap-2 text-red-600 dark:text-red-400">
        <AlertCircle className="h-4 w-4" />
        <span className="font-medium">Error</span>
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-red-100 p-2 font-mono text-xs text-red-700 dark:bg-red-900/30 dark:text-red-300">
        {error}
      </pre>
    </div>
  );
}

function getFileName(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}
