import { useCallback } from 'react';
import { TerminalType, instancePreferences, openTerminalFromComputeNode, dataContext } from '@sdk';
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
 * Hook that opens a terminal session. Always opens an in-app shell tab so flowpad
 * owns the PTY (winsize, resize, capture, replay all coherent). When the user
 * has opted into EXTERNAL_TERMINAL via instance preferences, additionally spawns
 * an external Terminal.app window as a sidecar — never as a replacement.
 */
export function useOpenTerminal() {
  const { navigation } = useDockNavigation();

  const open = useCallback(
    async (options: OpenTerminalOptions) => {
      void navigation.openNewShell({ startCommand: options.command, cwd: options.cwd });

      const terminalType = options.terminalType ?? instancePreferences.defaultTerminal;
      if (terminalType === TerminalType.EXTERNAL_TERMINAL) {
        const computeNodeId = dataContext.computeNode?.id;
        if (computeNodeId) {
          void openTerminalFromComputeNode(computeNodeId, options.command, options.cwd).catch(
            (e) => console.error('[useOpenTerminal] sidecar external terminal failed:', e),
          );
        }
      }
    },
    [navigation],
  );

  return { openTerminal: open };
}
