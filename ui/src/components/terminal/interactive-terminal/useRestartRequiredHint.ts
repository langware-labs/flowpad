import { AgenticProcess } from '@sdk';
import { isProcessRunning } from '@sdk/process/agentic-types.js';
import { useLingui } from '@lingui/react/macro';

/** Tooltip text for a running process that needs a restart, naming each
 *  launch-config field that changed since it started with its old → new value;
 *  null when none is needed. */
export function useRestartRequiredHint(process: AgenticProcess): string | null {
  const { t } = useLingui();
  if (!process.restart_required || !isProcessRunning(process.status)) return null;
  const changes = process.restart_changes ?? [];
  if (!changes.length) return t`Restart required — config changed since start`;
  const lines = changes.map((c) => `${c.field}: ${c.loaded} → ${c.current}`).join('; ');
  return t`Restart required — changed since start: ${lines}`;
}
