import { Button } from '@src/components/ui/button';
import { Loader2, Play, Zap } from 'lucide-react';

interface WorkflowToolbarProps {
  viewMode: 'source' | 'prepared';
  onViewModeToggle: () => void;
  isPrepared: boolean;
  isRunning: boolean;
  isPreparing: boolean;
  isStarting: boolean;
  onRun: () => void;
  onPrepare: () => void;
  hasSourcePath: boolean;
}

export function WorkflowToolbar({
  viewMode,
  onViewModeToggle,
  isPrepared,
  isRunning,
  isPreparing,
  isStarting,
  onRun,
  onPrepare,
  hasSourcePath,
}: WorkflowToolbarProps) {
  return (
    <>
      {isPrepared && (
        <Button
          variant="outline"
          size="sm"
          onClick={onViewModeToggle}
          title={viewMode === 'prepared' ? 'Switch to source view' : 'Switch to prepared view'}
        >
          {viewMode === 'prepared' ? 'Source' : 'Prepared'}
        </Button>
      )}
      <Button
        size="sm"
        variant="secondary"
        onClick={onPrepare}
        disabled={isPreparing || isRunning || isStarting || !hasSourcePath}
        title={!hasSourcePath ? 'No file linked' : isPreparing ? 'Preparing…' : 'Prepare workflow'}
      >
        {isPreparing ? (
          <Loader2 className="mr-1 h-4 w-4 animate-spin" />
        ) : (
          <Zap className="mr-1 h-4 w-4" />
        )}
        {isPreparing ? 'Preparing…' : 'Prepare'}
      </Button>
      <Button
        size="sm"
        onClick={onRun}
        disabled={isRunning || isStarting || isPreparing || !hasSourcePath}
        title={!hasSourcePath ? 'No file linked' : isRunning ? 'Workflow running…' : 'Run workflow'}
      >
        {isRunning || isStarting ? (
          <Loader2 className="mr-1 h-4 w-4 animate-spin" />
        ) : (
          <Play className="mr-1 h-4 w-4" />
        )}
        {isRunning ? 'Running…' : isStarting ? 'Starting…' : 'Run'}
      </Button>
    </>
  );
}
