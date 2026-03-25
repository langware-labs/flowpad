import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@src/components/ui/alert-dialog';
import { Button } from '@src/components/ui/button';
import { useSystemTools } from '@src/hooks/use-system-tools';
import { CheckCircle2, Circle, Loader2 } from 'lucide-react';
import { useState } from 'react';

export interface IndexNowModalProps {
  open: boolean;
  types: string[];
  onComplete: () => void;
  onDeny: () => void;
}

export function IndexNowModal({ open, types, onComplete, onDeny }: IndexNowModalProps) {
  const { indexTypes, currentActivity, activityProgress } = useSystemTools();
  const [phase, setPhase] = useState<'confirm' | 'indexing'>('confirm');

  const indexing = phase === 'indexing' && currentActivity === 'index';
  const progress = indexing ? activityProgress : null;

  async function startIndexing() {
    setPhase('indexing');
    await indexTypes(types);
    setPhase('confirm');
    onComplete();
  }

  function handleDeny() {
    setPhase('confirm');
    onDeny();
  }

  return (
    <AlertDialog open={open}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Make your records searchable</AlertDialogTitle>
          <AlertDialogDescription>
            Your records haven't been indexed yet. Building the index takes less than a minute and
            lets you find anything across all your notes, tasks, and sessions.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {phase === 'indexing' && progress && (
          <div className="flex flex-col gap-1 py-2">
            {types.map((t) => {
              const isDone = progress.done.includes(t);
              const isCurrent = progress.current === t;
              return (
                <div key={t} className="flex items-center gap-2 text-sm">
                  {isDone ? (
                    <CheckCircle2 className="h-4 w-4 text-green-500" />
                  ) : isCurrent ? (
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  ) : (
                    <Circle className="h-4 w-4 text-muted-foreground/40" />
                  )}
                  <span className={isDone ? 'text-muted-foreground line-through' : isCurrent ? '' : 'text-muted-foreground/60'}>
                    {t}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {phase === 'confirm' && (
          <AlertDialogFooter>
            <Button variant="outline" onClick={handleDeny}>
              Not Now
            </Button>
            <Button onClick={() => void startIndexing()}>Build Index</Button>
          </AlertDialogFooter>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}
