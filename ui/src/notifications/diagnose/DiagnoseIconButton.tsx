import { Stethoscope } from 'lucide-react';
import type { NotificationLevel } from '../types';
import { useLingui } from '@lingui/react/macro';
import { useDiagnoseErrorStore } from './diagnose-error-store';

/**
 * What the button needs to seed a diagnosis. `NotificationData` satisfies it
 * structurally, so alerts/toasts pass themselves; a derived warning (which is
 * not a notification) passes its own message + description.
 */
export interface DiagnoseSubject {
  level: NotificationLevel;
  title: string;
  message?: string;
}

/** Levels worth diagnosing — a warning is as diagnosable as an error. */
const DIAGNOSABLE: NotificationLevel[] = ['error', 'warning'];

/** The detail handed to the diagnosis: full message if present, else the title. */
function subjectDetail(subject: DiagnoseSubject): string {
  return [subject.title, subject.message].filter(Boolean).join('\n');
}

/**
 * Small tooltipped stethoscope shown on error and warning notifications.
 * Clicking it opens the confirmation modal (`DiagnoseErrorModal`) seeded with
 * the subject's detail. Rendered only for the levels in `DIAGNOSABLE` —
 * info/success have nothing to diagnose.
 */
export function DiagnoseIconButton({
  subject,
  className,
  iconClassName,
}: {
  subject: DiagnoseSubject;
  className?: string;
  /** Icon size — notification rows keep the default; a full-page surface (the
      error screen) sizes it up to sit next to a regular button. */
  iconClassName?: string;
}) {
  const open = useDiagnoseErrorStore((s) => s.open);
  const { t } = useLingui();
  if (!DIAGNOSABLE.includes(subject.level)) return null;

  const isWarning = subject.level === 'warning';
  const diagnoseLabel = isWarning ? t`Diagnose this warning` : t`Diagnose this error`;

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        open(subjectDetail(subject), isWarning ? 'warning' : 'error');
      }}
      title={diagnoseLabel}
      aria-label={diagnoseLabel}
      className={
        className ??
        'flex-shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40'
      }
    >
      <Stethoscope className={iconClassName ?? 'h-3.5 w-3.5'} />
    </button>
  );
}
