import { useCallback, useRef } from 'react';
import { AgenticProcess } from '@sdk';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { notify } from '@src/notifications';

/**
 * Hook that resumes a Claude/Codex worker session in a ProcessTerminal via
 * AgenticProcess.getByWorkerId. Pass `workerType` to skip the cross-vendor disk
 * probe; the backend auto-discovers it when omitted.
 */
export function useResumeInTerminal() {
  const { navigation } = useDockNavigation();
  const creatingRef = useRef(false);

  const resumeInTerminal = useCallback(
    (workerId: string, _cwd?: string, timestamp?: string, workerType?: string | null) => {
      if (!workerId || creatingRef.current) return;

      creatingRef.current = true;

      void (async () => {
        try {
          const p = await AgenticProcess.getByWorkerId(workerId, workerType ?? null);
          if (!p) {
            notify.error({ title: 'Session not found', message: `Session ${workerId} is not in Claude, Codex, Copilot or OpenCode history.`, id: `session-not-found:${workerId}` });
            return;
          }
          // The bookmark/open-session UX wants the live PTY (the timestamp
          // jumps to a moment in the running terminal), not the read-only
          // transcript that ``dockPointer`` resolves to. Use the explicit
          // terminal pointer so the URL contains the process id and the
          // ``?t=`` query param the test asserts.
          navigation.openDockPointer(p.terminalDockPointer, timestamp ? { t: timestamp } : undefined);
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
