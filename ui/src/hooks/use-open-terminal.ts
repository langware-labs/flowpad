import { useCallback } from 'react';
import { TerminalType, workspaceSetting, openTerminalFromComputeNode, dataContext } from '@sdk';
import { useDockNavigation } from '@src/navigation/useDockNavigation';

export interface OpenTerminalOptions {
  command: string;
  cwd?: string;
  terminalType?: TerminalType;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function withCwd(command: string, cwd?: string): string {
  if (!cwd) return command;
  return `cd ${shellQuote(cwd)} && ${command}`;
}

/**
 * Hook that opens a terminal session, routing to builtin xterm or external OS terminal
 * based on workspace settings.
 *
 * For builtin xterm: navigates to a new shell tab with the command passed via URL query params.
 * For external terminal: delegates to openTerminalFromComputeNode().
 */
export function useOpenTerminal() {
  const { navigation } = useDockNavigation();

  const open = useCallback(
    async (options: OpenTerminalOptions) => {
      const terminalType = options.terminalType ?? workspaceSetting.defaultTerminal;

      if (terminalType === TerminalType.EXTERNAL_TERMINAL) {
        const computeNodeId = dataContext.computeNode?.id;
        if (!computeNodeId) {
          throw new Error('No compute node available');
        }
        await openTerminalFromComputeNode(computeNodeId, options.command, options.cwd);
        return;
      }

      // Builtin xterm: navigate to shell with startCommand.
      void navigation.openNewShell({ startCommand: options.command, cwd: options.cwd });
    },
    [navigation],
  );

  return { openTerminal: open };
}
