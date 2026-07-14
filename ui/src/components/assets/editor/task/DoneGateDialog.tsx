import { Task } from '@sdk';
import { missingDoneGateFields } from '@src/components/task-bar/constants';
import { Button } from '@src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import { AnalyzeStatusButton } from './AnalyzeStatusButton';

interface DoneGateDialogProps {
  task: Task;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Complete the pending Done save (the click the gate intercepted). */
  onConfirmDone: () => void;
}

/**
 * The Done-gate: shown when the user flips a task to Done while important
 * fields (DONE_GATE_FIELDS) are still empty. Suggests Analyze Status — the
 * wizard fills what it can itself — but NEVER hard-blocks ("Mark done anyway"
 * is always available).
 */
export function DoneGateDialog({ task, open, onOpenChange, onConfirmDone }: DoneGateDialogProps) {
  const missing = missingDoneGateFields(task as unknown as Record<string, unknown>);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="done-gate-dialog">
        <DialogHeader>
          <DialogTitle>Before you mark this done…</DialogTitle>
          <DialogDescription>
            Some fields that show your work are still empty. Analyze Status can inspect the task folder and git state
            and fill them in for you.
          </DialogDescription>
        </DialogHeader>

        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          {missing.map((m) => (
            <li key={m.field}>{m.label}</li>
          ))}
        </ul>

        <DialogFooter className="gap-2 sm:justify-between">
          <AnalyzeStatusButton
            task={task}
            className="border-primary/40 text-primary hover:bg-primary/5"
            onAnalyzed={() => {
              // Re-check after the wizard: all filled → complete the pending
              // Done; otherwise stay open showing what remains.
              const remaining = missingDoneGateFields(task as unknown as Record<string, unknown>);
              if (remaining.length === 0) {
                onOpenChange(false);
                onConfirmDone();
              }
            }}
          />
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              variant="secondary"
              data-testid="done-gate-anyway"
              onClick={() => {
                onOpenChange(false);
                onConfirmDone();
              }}
            >
              Mark done anyway
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
