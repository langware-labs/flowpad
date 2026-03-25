import { Button } from '@src/components/ui/button';
import { WorkflowStatus } from '@sdk';
import { Play, Square } from 'lucide-react';

interface ExecutionControlsProps {
  status: WorkflowStatus;
  onExecute: () => void;
  onStop: () => void;
  disabled?: boolean;
}

export function ExecutionControls({ status, onExecute, onStop, disabled }: ExecutionControlsProps) {
  const canExecute =
    status === WorkflowStatus.IDLE || status === WorkflowStatus.FAILED || status === WorkflowStatus.COMPLETED;
  const canStop = status === WorkflowStatus.RUNNING;

  return (
    <div className="flex items-center gap-2 border-b p-2">
      {canExecute && (
        <Button size="sm" onClick={onExecute} disabled={disabled} className="gap-1">
          <Play className="h-4 w-4" />
          Execute
        </Button>
      )}
      {canStop && (
        <Button size="sm" variant="secondary" onClick={onStop} disabled={disabled} className="gap-1">
          <Square className="h-4 w-4" />
          Stop
        </Button>
      )}
      <div className="ml-auto text-xs text-muted-foreground">
        {status === WorkflowStatus.RUNNING && 'Executing...'}
        {status === WorkflowStatus.COMPLETED && 'Completed'}
        {status === WorkflowStatus.FAILED && 'Failed'}
      </div>
    </div>
  );
}
