import { useCallback, useRef } from 'react';
import { AgenticProcess } from '@sdk';
import { useDockNavigation } from '@src/navigation/useDockNavigation';

/**
 * Hook that resumes a Claude CLI session in a ProcessTerminal (with toolbar).
 * Creates an AgenticProcess, sets the worker session ID, and resumes via PTY.
 */
export function useResumeInTerminal() {
  const { navigation } = useDockNavigation();
  const creatingRef = useRef(false);

  const resumeInTerminal = useCallback(
    (sessionId: string, cwd?: string, timestamp?: string) => {
      if (!sessionId || creatingRef.current) return;

      creatingRef.current = true;

      void (async () => {
        try {
          const p = await AgenticProcess.fromClaudeSession(sessionId);
          try {
            await p.start({ visible: true });
          } catch {
            // Shell already active — visible was still set on the backend
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
