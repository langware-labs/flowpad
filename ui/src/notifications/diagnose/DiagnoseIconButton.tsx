import { Stethoscope } from 'lucide-react';
import type { NotificationData } from '../types';
import { useLingui } from '@lingui/react/macro';
import { useCloudStatus } from '@sdk/react/hooks';
import { isHubConnected } from '@sdk/services/cloud_status';
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
  // Diagnosis runs a headless AI agent that needs an internet connection; disable
  // the trigger when the cloud is unreachable (a good proxy for "offline") so a
  // click can't fail with a misleading "no transcript" error.
  const { connection } = useCloudStatus();
  const online = isHubConnected(connection.status);
  if (data.level !== 'error') return null;

  const diagnoseLabel = online
    ? t`Diagnose this error`
    : t`Diagnosis needs an internet connection — you appear to be offline`;

  return (
    <button
      type="button"
      disabled={!online}
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
