/**
 * ProcessTerminal — renders the PTY terminal for an AgenticProcess entity.
 *
 * On mount, links the shell session to the process so that TabbedTerminal's
 * tab-switching callback can navigate to the correct URL (agenticProcess or plain shell).
 */

import { useEntity } from '@src/hooks/entity-hooks';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { TabbedTerminal } from '@src/components/terminal';
import type { AgenticProcess } from '@sdk';

interface ProcessTerminalProps {
  processId: string;
  addTabButton?: boolean;
}

export function ProcessTerminal({ processId, addTabButton }: ProcessTerminalProps) {
  const { data: process } = useEntity(processId);
  const { navigation } = useDockNavigation();

  const handleActiveSessionChange = (sessionId: string) => {
    if ((process as any)?.shell_id === sessionId) {
      navigation.openShellProcess(processId);
    } else {
      navigation.openShell(sessionId);
    }
  };

  const shellId = (process as AgenticProcess | null)?.shell_id ?? null;

  if (process && !shellId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <span className="text-sm">Disconnected</span>
      </div>
    );
  }

  return (
    <TabbedTerminal
      className="h-full"
      addTabButton={addTabButton}
      onActiveSessionChange={handleActiveSessionChange}
    />
  );
}
