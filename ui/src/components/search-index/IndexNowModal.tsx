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
import { useState } from 'react';
import { ActivityIndicator } from './ActivityIndicator';

export interface IndexNowModalProps {
  open: boolean;
  types: string[];
  onComplete: () => void;
  onDeny: () => void;
}

export function IndexNowModal({ open, types, onComplete, onDeny }: IndexNowModalProps) {
  const { indexTypes } = useSystemTools();
  const [phase, setPhase] = useState<'confirm' | 'indexing'>('confirm');

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

        {phase === 'indexing' && <ActivityIndicator variant="list" types={types} />}

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
