import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@src/components/ui/alert-dialog';

export interface BulkBucket {
  label: string;
  count: number;
  /** Optional explanatory line shown under the label/count row. */
  description?: string;
  tone?: 'destructive' | 'default' | 'muted';
}

interface BulkConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Per-bucket breakdown shown above the confirm button. Zero-count
   *  buckets are hidden automatically so the user only sees the buckets
   *  that actually apply. */
  buckets: BulkBucket[];
  /** Optional intro paragraph above the bucket list. */
  intro?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'default' | 'destructive';
  onConfirm: () => void;
  onCancel?: () => void;
}

const TONE_CLASS: Record<NonNullable<BulkBucket['tone']>, string> = {
  destructive: 'text-destructive font-medium',
  default: 'text-foreground',
  muted: 'text-muted-foreground',
};

export function BulkConfirmDialog({
  open,
  onOpenChange,
  title,
  intro,
  buckets,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'destructive',
  onConfirm,
  onCancel,
}: BulkConfirmDialogProps) {
  const visible = buckets.filter((b) => b.count > 0);
  const total = visible.reduce((s, b) => s + b.count, 0);

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
          {intro && <AlertDialogDescription>{intro}</AlertDialogDescription>}
        </AlertDialogHeader>
        <ul className="my-2 space-y-1 rounded-md border bg-muted/30 p-3 text-sm">
          {visible.length === 0 && (
            <li className="text-muted-foreground">Nothing to do.</li>
          )}
          {visible.map((b) => (
            <li
              key={b.label}
              className={`flex items-baseline justify-between gap-3 ${
                TONE_CLASS[b.tone ?? 'default']
              }`}
            >
              <span>
                {b.label}
                {b.description && (
                  <span className="ml-2 text-xs text-muted-foreground">
                    {b.description}
                  </span>
                )}
              </span>
              <span className="font-mono tabular-nums">{b.count}</span>
            </li>
          ))}
          {visible.length > 1 && (
            <li className="mt-2 flex items-baseline justify-between gap-3 border-t pt-2 text-sm font-semibold">
              <span>Total</span>
              <span className="font-mono tabular-nums">{total}</span>
            </li>
          )}
        </ul>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={handleCancel}>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            disabled={total === 0}
            className={
              variant === 'destructive'
                ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                : ''
            }
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
