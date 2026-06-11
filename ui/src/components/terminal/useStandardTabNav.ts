import { useCallback, useRef } from 'react';
import { terminalTargetKey, type TerminalTab } from '@src/tabs/useTabs';
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
  // MRU stack of terminal target TypeId strings, most-recent first. Updated on tab clicks only.
  const mruRef = useRef<string[]>([]);

  const touchMru = useCallback((targetKey: string) => {
    mruRef.current = [targetKey, ...mruRef.current.filter((id) => id !== targetKey)];
  }, []);

  const onTabClick = useCallback(
    (_targetKey: string, session: TerminalTab) => {
      touchMru(terminalTargetKey(session));
      const pointer = session.agenticProcess?.terminalDockPointer ?? session.shell?.dockPointer;
      if (pointer) navigation.openDock(pointer);
    },
    [navigation, touchMru],
  );

  const onTabClose = useCallback(
    (targetKeyOrKeys: string | string[]) => {
      const closed = new Set(Array.isArray(targetKeyOrKeys) ? targetKeyOrKeys : [targetKeyOrKeys]);
      mruRef.current = mruRef.current.filter((id) => !closed.has(id));
      const nextId = mruRef.current[0];
      if (!nextId) {
        navigation.openDock(DockPointer.forShell());
      }
      // When there is a next-in-MRU, we don't need to navigate: the loader will
      // pick a default target once the closed terminal drops off the entity
      // list. The MRU only matters once the consumer wants to force a specific
      // tab — clicks do that already.
    },
    [navigation],
  );

  const onTabOpen = useCallback(
    (session: TerminalTab) => {
      touchMru(terminalTargetKey(session));
      const pointer = session.agenticProcess?.terminalDockPointer ?? session.shell?.dockPointer;
      if (pointer) navigation.openDock(pointer);
    },
    [navigation, touchMru],
  );

  return { onTabClick, onTabClose, onTabOpen };
}
