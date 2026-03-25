import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useEffect } from 'react';

/**
 * Component that listens for the 'open-claude-login-terminal' custom event
 * and opens the terminal session. Must be rendered inside Router context.
 */
export function ClaudeLoginTerminalHandler() {
  const { navigation } = useDockNavigation();

  useEffect(() => {
    const handleOpenTerminal = (event: CustomEvent<{ sessionId: string }>) => {
      const { sessionId } = event.detail;
      if (sessionId) {
        navigation.openDock(DockPointer.forShell(sessionId, { startClaude: false }));
      }
    };

    window.addEventListener('open-claude-login-terminal', handleOpenTerminal as EventListener);

    return () => {
      window.removeEventListener('open-claude-login-terminal', handleOpenTerminal as EventListener);
    };
  }, [navigation]);

  return null; // This component doesn't render anything
}
