/**
 * ProcessTerminal — the PTY terminal BODY for an AgenticProcess, rendered inside
 * the content panel (whose header already provides the shared `UnifiedTabStrip`),
 * so it renders only the body. A guard shows "Disconnected" when the process has
 * no live shell.
 */

import { useEntity } from '@src/hooks/entity-hooks';
import { TabbedTerminal } from '@src/components/terminal';
import { DockPointer } from '@src/navigation/DockPointer';
import { AgenticProcess, TypeId } from '@sdk';

interface ProcessTerminalProps {
  processId: string;
}

export function ProcessTerminal({ processId }: ProcessTerminalProps) {
  // Accept either a bare id or a full `agentic_process-<id>` pointer.
  const normalizedProcessId = DockPointer.isAgenticProcessPointer(processId)
    ? DockPointer.extractAgenticProcessId(processId)
    : processId;

  const { data: process } = useEntity<AgenticProcess>(
    normalizedProcessId ? new TypeId(AgenticProcess.type, normalizedProcessId) : null,
  );
  const shellId = (process as AgenticProcess | null)?.shell_id ?? null;

  if (process && !shellId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <span className="text-sm">Disconnected</span>
      </div>
    );
  }

  return <TabbedTerminal className="h-full" />;
}
