import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@src/components/ui/alert-dialog';
import { Button } from '@src/components/ui/button';
import { workerLabel } from '@src/components/lens-viewer/shared/transcript-features/transcript-utils';
import type { WorkerType } from '@src/components/workers/worker-types';
import { useLingui } from '@lingui/react/macro';

export type VibeWorkerSwitchIntent = 'new' | 'continue';

export function VibeWorkerSwitchDialog({
  open,
  workerType,
  inFlight,
  onStartNew,
  onContinue,
  onCancel,
}: {
  open: boolean;
  workerType: WorkerType;
  inFlight: VibeWorkerSwitchIntent | null;
  onStartNew: () => void;
  onContinue: () => void;
  onCancel: () => void;
}) {
  const { t } = useLingui();
  const disabled = inFlight !== null;

  return (
    <AlertDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !disabled) onCancel();
      }}
    >
      <AlertDialogContent data-testid="vibe-worker-switch-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{t`Switch to ${workerLabel(workerType)}?`}</AlertDialogTitle>
          <AlertDialogDescription>
            {t`Start with an empty chat or carry this conversation into the new worker. The current chat stays in Recent.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button type="button" variant="outline" disabled={disabled} onClick={onCancel}>
            {t`Cancel`}
          </Button>
          <Button type="button" variant="outline" disabled={disabled} onClick={onStartNew}>
            {t`Start new`}
          </Button>
          <Button type="button" disabled={disabled} onClick={onContinue}>
            {t`Continue this conversation`}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
