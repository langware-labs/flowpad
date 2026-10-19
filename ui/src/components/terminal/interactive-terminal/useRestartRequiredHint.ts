import { AgenticProcess } from '@sdk';
import { isProcessRunning } from '@sdk/process/agentic-types.js';
import { useLingui } from '@lingui/react/macro';

/** Tooltip text for a running process that needs a restart, naming the
 *  launch-config fields that changed since it started; null when none is needed. */
export function useRestartRequiredHint(process: AgenticProcess): string | null {
  const { t } = useLingui();
  if (!process.restart_required || !isProcessRunning(process.status)) return null;
  const fields = process.restart_changed_fields ?? [];
  return fields.length
    ? t`Restart required — changed since start: ${fields.join(', ')}`
    : t`Restart required — config changed since start`;
}
