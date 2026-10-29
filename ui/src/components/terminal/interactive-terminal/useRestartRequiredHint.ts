import { AgenticProcess } from '@sdk';
import { isProcessRunning } from '@sdk/process/agentic-types.js';
import { useLingui } from '@lingui/react/macro';
import { changeLabel } from './RestartChangesList';

/** One-line text for a running process that needs a restart, naming the changed
 *  settings (aria-label, menu hint). The full list is RestartChangesList.
 *  Null when no restart is needed. */
export function useRestartRequiredHint(process: AgenticProcess): string | null {
  const { t } = useLingui();
  if (!process.restart_required || !isProcessRunning(process.status)) return null;
  const changes = process.restart_changes ?? [];
  if (!changes.length) return t`Restart required — settings changed since start`;
  const names = changes.map(changeLabel).join(', ');
  return t`Restart to apply: ${names}`;
}
