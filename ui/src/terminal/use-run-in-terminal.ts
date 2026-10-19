import { dataContext, Shell, tabManager } from '@sdk';
import { useCallback } from 'react';

import { useDockNavigation } from '@src/navigation/useDockNavigation';

/**
 * Run a command in a terminal: the project's open shell tab when there is one, a new shell tab
 * otherwise, in the view mode the person is already in.
 *
 * URL-first like every other open: it only navigates, carrying the command as the dock's
 * `startCommand`, and the mounted terminal types it once its PTY is at a prompt (see
 * `START_COMMAND_PARAM`). Only plain shells are reused — an agent's terminal is running a CLI, and
 * a command typed into it would land as a prompt, not a command.
 */
export function useRunInTerminal(): (command: string) => Promise<void> {
  const { navigation, currentDock } = useDockNavigation();
  return useCallback(
    async (command: string) => {
      const viewMode = currentDock?.viewMode ?? undefined;
      const projectId = dataContext.project?.id ?? null;
      const shells = (await tabManager.getTerminalTabsSnapshot('project', projectId)).filter(
        (tab) => tab.target_type === Shell.type && tab.target_id,
      );
      const onScreen = currentDock?.shellId;
      const target = shells.find((tab) => tab.target_id === onScreen) ?? shells[0];
      if (target?.target_id) {
        const shown = await navigation.openShell(target.target_id, { startCommand: command, viewMode });
        if (shown) return;
      }
      await navigation.openNewShell({ startCommand: command, viewMode });
    },
    [currentDock, navigation],
  );
}
