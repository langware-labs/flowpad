import { AgenticProcess } from '@sdk';
import { isProcessRunning } from '@sdk/process/agentic-types.js';
import { useLingui } from '@lingui/react/macro';

/** Tooltip text for a running process that needs a restart: one short line per
 *  changed launch setting (what was added/removed/changed), and where to see the
 *  full Loaded vs Current view. Null when no restart is needed. */
export function useRestartRequiredHint(process: AgenticProcess): string | null {
  const { t } = useLingui();
  if (!process.restart_required || !isProcessRunning(process.status)) return null;
  const changes = process.restart_changes ?? [];
  if (!changes.length) return t`Settings changed since this session started — restart to apply`;
  const lines = changes
    .map((c) => `• ${c.field.replace(/_/g, ' ')}: ${c.summary ?? `${c.loaded} → ${c.current}`}`)
    .join('\n');
  return t`Restart to apply what changed since this session started:\n${lines}\nFull comparison: Debug menu → Command Status`;
}
