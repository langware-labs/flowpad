import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogHeader, AlertDialogTitle } from '@src/components/ui/alert-dialog';
import { AlertDialogFooter } from '@src/components/ui/alert-dialog';

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'default' | 'destructive';
  onConfirm: () => void;
  onCancel?: () => void;
  /**
   * The thing being acted on, when there is one.
   *
   * Passing it makes the dialog say so when the action reaches a CLOUD
   * resource: `remote` means this row has a hub counterpart at the same id, so
   * deleting it does not just drop a local record — it destroys a real machine
   * or resource that someone is paying for. Derived here rather than spelled
   * out per call site, so a new destructive surface inherits the warning
   * instead of forgetting it.
   */
  entity?: { remote?: boolean } | null;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'default',
  onConfirm,
  onCancel,
  entity,
}: ConfirmDialogProps) {
  const handleConfirm = () => {
    onConfirm();
    onOpenChange(false);
  };

  const handleCancel = () => {
    onCancel?.();
    onOpenChange(false);
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
          {entity?.remote && (
            <AlertDialogDescription className="font-medium text-destructive">
              This is a cloud resource — it will be destroyed in the cloud, not just here.
            </AlertDialogDescription>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={handleCancel}>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            className={
              variant === 'destructive' ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90' : ''
            }
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
