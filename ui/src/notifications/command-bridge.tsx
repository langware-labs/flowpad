import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { useResumeInTerminal } from '@src/hooks/use-resume-in-terminal';
import { registerCommand, registerNavigate } from './commands';

/**
 * Registers the hook-bound notification commands (and the URL-first navigation
 * handle) into the command registry. Mount once, inside the router subtree
 * (e.g. in App). Hook-free commands are registered statically in `commands.ts`.
 */
export function NotificationCommandBridge() {
  const navigate = useNavigate();
  const { resumeInTerminal } = useResumeInTerminal();

  useEffect(() => {
    registerNavigate((href) => navigate(href));
    registerCommand('terminal.resume', (args) => {
      if (args.sessionId) resumeInTerminal(String(args.sessionId), args.cwd ? String(args.cwd) : undefined);
    });
  }, [navigate, resumeInTerminal]);

  return null;
}
