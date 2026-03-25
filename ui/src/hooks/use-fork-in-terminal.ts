import { AgenticProcess, dataContext } from '@sdk';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useCallback, useRef } from 'react';

/**
 * Hook that forks a Claude session by starting a fresh Claude process
 * in the same working directory. Unlike resume (which continues the same
 * conversation), fork opens a brand-new interactive session so you can
 * explore a different direction from the same codebase.
 */
export function useForkInTerminal() {
  const { navigation } = useDockNavigation();
  const creatingRef = useRef(false);

  const forkInTerminal = useCallback(
    (cwd?: string) => {
      if (creatingRef.current) return;

      creatingRef.current = true;

      void (async () => {
        try {
          const workdir = cwd || dataContext.project?.fs_storage_mount_path;
          const { process: agenticProcess } = await AgenticProcess.spawn(
            { ...(workdir ? { workdir } : {}) },
            { visible: true, watchProcessor: false, watchProcess: false },
          );
          navigation.openDockPointer(agenticProcess.dockPointer);
        } catch (error) {
          console.error('[useForkInTerminal] Failed to fork session:', error);
        } finally {
          creatingRef.current = false;
        }
      })();
    },
    [navigation],
  );

  return { forkInTerminal };
}
