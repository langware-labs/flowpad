import { Stethoscope } from 'lucide-react';
import type { NotificationData } from '../types';
import { useLingui } from '@lingui/react/macro';
import { useDiagnoseErrorStore } from './diagnose-error-store';

/** The error detail handed to the diagnosis: full message if present, else the title. */
function errorDetail(data: NotificationData): string {
  return [data.title, data.message].filter(Boolean).join('\n');
}

/**
 * Small tooltipped stethoscope shown on error notifications. Clicking it opens
 * the confirmation modal (`DiagnoseErrorModal`) seeded with the error detail.
 * Rendered only for `level === 'error'` notifications.
 */
export function DiagnoseIconButton({ data, className }: { data: NotificationData; className?: string }) {
  const open = useDiagnoseErrorStore((s) => s.open);
  const { t } = useLingui();
  if (data.level !== 'error') return null;

  const diagnoseLabel = t`Diagnose this error`;

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        open(errorDetail(data));
      }}
      title={diagnoseLabel}
      aria-label={diagnoseLabel}
      className={
        className ??
        'flex-shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40'
      }
    >
      <Stethoscope className="h-3.5 w-3.5" />
    </button>
  );
}
