import { useLingui } from '@lingui/react/macro';
import { cn } from '@src/lib/utils';

// The tones the automation result card uses for the same words (`automation-result-viewer/viewer.js`).
const TONE: Record<string, string> = {
  done: 'border-green-500/50 bg-green-500/15',
  expired: 'border-yellow-500/50 bg-yellow-500/15',
  needs_review: 'border-yellow-500/50 bg-yellow-500/15',
  failed: 'border-red-500/60 bg-red-500/15',
};

/** Where an app message's work stands (`MessageApp.status`), as a chip; nothing for no status. */
export function AppStatusChip({ status, className }: { status?: string | null; className?: string }) {
  const { t } = useLingui();
  if (!status) return null;
  const label: Record<string, string> = {
    done: t`Done`,
    expired: t`Expired`,
    cancelled: t`Cancelled`,
    needs_review: t`Needs review`,
    failed: t`Failed`,
  };
  return (
    <span
      data-testid="app-status-chip"
      data-status={status}
      className={cn(
        'inline-block rounded-full border border-border bg-muted px-2 align-middle text-[11px] font-medium text-foreground',
        TONE[status],
        className,
      )}
    >
      {label[status] ?? status}
    </span>
  );
}
