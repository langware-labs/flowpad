/**
 * ProcessTerminal — the PTY terminal BODY for an AgenticProcess, rendered inside
 * the content panel (whose header already provides the shared `UnifiedTabStrip`),
 * so it renders only the body. A guard shows "Disconnected" when the process has
 * no live shell.
 */

import { useEntity } from '@src/hooks/entity-hooks';
import { TabbedTerminal } from '@src/components/terminal';
import { AgenticProcess, TypeId } from '@sdk';

interface ProcessTerminalProps {
  processId: string;
}

export function ProcessTerminal({ processId }: ProcessTerminalProps) {
  const { data: process } = useEntity<AgenticProcess>(
    processId ? new TypeId(AgenticProcess.type, processId) : null,
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
