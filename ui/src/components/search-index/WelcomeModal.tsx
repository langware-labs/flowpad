import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@src/components/ui/alert-dialog';
import { Button } from '@src/components/ui/button';

const SKIP_KEY = 'flowpad-welcome-skipped';

export interface WelcomeModalProps {
  open: boolean;
  onStart: () => void;
  onSkip: () => void;
}

export function WelcomeModal({ open, onStart, onSkip }: WelcomeModalProps) {
  const skippedBefore = localStorage.getItem(SKIP_KEY) === 'true';

  function handleSkip() {
    localStorage.setItem(SKIP_KEY, 'true');
    onSkip();
  }

  return (
    <AlertDialog open={open}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {skippedBefore ? 'Set up Flowpad' : 'Welcome to Flowpad!'}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {skippedBefore
              ? 'Flowpad hasn\'t indexed your data yet. Would you like to discover and index your skills, sessions, bookmarks, tasks, errors, and more? This usually takes less than a minute.'
              : 'Since this is your first time, Flowpad needs to discover and index your data \u2014 skills, sessions, bookmarks, tasks, errors, and more. This usually takes less than a minute.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="ghost" onClick={handleSkip} data-testid="welcome-skip-button">
            Skip for now
          </Button>
          <Button className="bg-green-600 hover:bg-green-700 text-white" onClick={onStart}>
            Let's go
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
