import { useCallback } from 'react';
import { TerminalType, instancePreferences, openTerminalFromComputeNode, dataContext, shellQuote } from '@sdk';
import { useDockNavigation } from '@src/navigation/useDockNavigation';

/** Re-exported so existing `@src/hooks/use-open-terminal` importers keep working. */
export { shellQuote };

export interface OpenTerminalOptions {
  command: string;
  cwd?: string;
  terminalType?: TerminalType;
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
