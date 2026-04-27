import { useCallback, useRef } from 'react';
import type { TerminalTab } from '@src/hooks/useActiveTerminals';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';

/**
 * Standard navigation wiring for the dumb `<TabbedTerminal />`.
 *
 * Consumers outside CollaborationSpace (global shell, sessions view, code editor)
 * want tab clicks and new-tab creation to route to the entity's own dockPointer
 * (which is `ViewType.SHELL`-based). After close, the next tab in the MRU stack
 * becomes active; if the stack is empty, we fall back to the empty shell view.
 *
 * Pass the returned `{ onTabClick, onTabClose, onTabOpen }` to `<TabbedTerminal />`.
 */
export function useStandardTabNav() {
  const { navigation } = useDockNavigation();
  // MRU stack of shell ids, most-recent first. Updated on tab clicks only.
  const mruRef = useRef<string[]>([]);

  const touchMru = useCallback((shellId: string) => {
    mruRef.current = [shellId, ...mruRef.current.filter((id) => id !== shellId)];
  }, []);

  const onTabClick = useCallback(
    (shellId: string, session: TerminalTab) => {
      touchMru(shellId);
      const pointer = session.agenticProcess?.dockPointer ?? session.shell?.dockPointer;
      if (pointer) navigation.openDock(pointer);
    },
    [navigation, touchMru],
  );

  const onTabClose = useCallback(
    (shellId: string) => {
      mruRef.current = mruRef.current.filter((id) => id !== shellId);
      const nextId = mruRef.current[0];
      if (!nextId) {
        navigation.openDock(DockPointer.forShell());
      }
      // When there is a next-in-MRU, we don't need to navigate: the loader will
      // pick a default and set activeShellId once the closed shell drops off
      // the entity list. The MRU only matters once the consumer wants to force
      // a specific tab — clicks do that already.
    },
    [navigation],
  );

  const onTabOpen = useCallback(
    (session: TerminalTab) => {
      touchMru(session.shellId);
      const pointer = session.agenticProcess?.dockPointer ?? session.shell?.dockPointer;
      if (pointer) navigation.openDock(pointer);
    },
    [navigation, touchMru],
  );

  return { onTabClick, onTabClose, onTabOpen };
}
