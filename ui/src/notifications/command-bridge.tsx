import { useEffect } from 'react';
import { dataManager, Task, TypeId } from '@sdk';
import { useNavigate } from 'react-router';
import { useResumeInTerminal } from '@src/hooks/use-resume-in-terminal';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { openAgenticProcess } from '@src/navigation/agentic-process-open';
import { registerCommand, registerNavigate } from './commands';

/**
 * Registers the hook-bound notification commands (and the URL-first navigation
 * handle) into the command registry. Mount once, inside the router subtree
 * (e.g. in App). Hook-free commands are registered statically in `commands.ts`.
 */
export function NotificationCommandBridge() {
  const navigate = useNavigate();
  const { resumeInTerminal } = useResumeInTerminal();
  const { navigation } = useDockNavigation();

  useEffect(() => {
    registerNavigate((href) => navigate(href));
    registerCommand('terminal.resume', (args) => {
      if (args.sessionId) resumeInTerminal(String(args.sessionId), args.cwd ? String(args.cwd) : undefined);
    });
    // Open a process from a notification the same way the footer's process list
    // does (live terminal for visible workers, transcript lens for headless).
    registerCommand('process.open', (args) => {
      if (args.processId) void openAgenticProcess(String(args.processId), navigation);
    });
    // Open a task (e.g. the "Task it" toast's Open) — URL-first, its own dock pointer.
    registerCommand('task.open', (args) => {
      if (!args.typeId) return;
      void dataManager.getByTypeId<Task>(new TypeId(String(args.typeId))).then((task) => {
        if (task) navigation.openDock(task.dockPointer);
      });
    });
  }, [navigate, resumeInTerminal, navigation]);

  return null;
}
