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
import { INDEX_BUILD_LABEL, INDEX_PROMPT_DESCRIPTION, INDEX_PROMPT_TITLE } from './index-copy';

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
          <AlertDialogTitle>{INDEX_PROMPT_TITLE}</AlertDialogTitle>
          <AlertDialogDescription>{INDEX_PROMPT_DESCRIPTION}</AlertDialogDescription>
        </AlertDialogHeader>

        {phase === 'indexing' && <ActivityIndicator variant="list" types={types} />}

        {phase === 'confirm' && (
          <AlertDialogFooter>
            <Button variant="outline" onClick={handleDeny}>
              Not Now
            </Button>
            <Button onClick={() => void startIndexing()}>{INDEX_BUILD_LABEL}</Button>
          </AlertDialogFooter>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}
