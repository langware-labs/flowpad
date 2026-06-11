import { useCallback, useRef } from 'react';
import { Shell, ViewType } from '@sdk';
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
  const { navigation, currentDock } = useDockNavigation();
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
      // Navigate ONLY when the closed tab is the one the URL is showing —
      // closing a background tab must not yank the user off the current view.
      // (The strip renders app-globally now; the old unconditional shell-view
      // fallback predates that and only ran inside the shell view.)
      const urlKey =
        currentDock?.viewType === ViewType.SHELL && currentDock.pointer
          ? DockPointer.isAgenticProcessPointer(currentDock.pointer)
            ? `agentic_process-${DockPointer.extractAgenticProcessId(currentDock.pointer)}`
            : currentDock.pointer.startsWith(Shell.type + '-')
              ? currentDock.pointer
              : `${Shell.type}-${currentDock.pointer}`
          : null;
      if (!urlKey || !closed.has(urlKey)) return;
      // Active tab closed: re-enter the shell route pointer-less; the loader
      // resolves the next tab via resolveNextTab (recency → order).
      navigation.openDock(DockPointer.forShell());
    },
    [navigation, currentDock],
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
