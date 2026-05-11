import { useCallback, useRef } from 'react';
import { AgenticProcess } from '@sdk';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { toast } from '@src/hooks/use-toast';

/**
 * Hook that resumes a Claude/Codex worker session in a ProcessTerminal.
 * Backend auto-discovers worker_type via AgenticProcess.getByWorkerId.
 */
export function useResumeInTerminal() {
  const { navigation } = useDockNavigation();
  const creatingRef = useRef(false);

  const resumeInTerminal = useCallback(
    (workerId: string, _cwd?: string, timestamp?: string) => {
      if (!workerId || creatingRef.current) return;

      creatingRef.current = true;

      void (async () => {
        try {
          const p = await AgenticProcess.getByWorkerId(workerId);
          if (!p) {
            toast({ title: 'Session not found', description: `Session ${workerId} is not in Claude or Codex history.`, variant: 'destructive' });
            return;
          }
          navigation.openDockPointer(p.dockPointer, timestamp ? { t: timestamp } : undefined);
        } catch (error) {
          console.error('[useResumeInTerminal] Failed to resume process:', error);
        } finally {
          creatingRef.current = false;
        }
      })();
    },
    [navigation],
  );

  return { resumeInTerminal };
}
