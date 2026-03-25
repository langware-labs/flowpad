import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import { InteractiveTerminal } from '@src/components/terminal';
import { dataContext, Shell } from '@sdk';
import { DockPointer, useDockNavigation } from '@src/navigation';
import { ViewType } from '@src/types/ViewType';
import { useEffect, useRef } from 'react';

/**
 * CodingAgentView - Split view with Claude CLI terminal and trace section
 * Left panel (70%): Interactive terminal running Claude CLI with session ID
 * Right panel (30%): Trace section showing execution traces
 */
export function CodingAgentView() {
  const { flow } = useAgentContext();
  const { navigation, currentDock, isDockUrl } = useDockNavigation();
  const commandSentRef = useRef<string | null>(null);
  const sessionIdSetRef = useRef<string | null>(null);
  const previousSessionIdRef = useRef<string | null>(null);

  // Determine if this view is currently active
  const active = isDockUrl && currentDock?.viewType === ViewType.NEW_CODING_AGENT_CLI;

  // Get session ID from URL dock pointer
  const sessionId = currentDock?.pointer;

  // Reset refs when navigating to a new session or when view becomes inactive
  useEffect(() => {
    const previousSessionId = previousSessionIdRef.current;
    previousSessionIdRef.current = sessionId || null;

    if (!active) {
      // View is inactive - reset refs for next time
      commandSentRef.current = null;
      sessionIdSetRef.current = null;
    } else if (active && !sessionId) {
      // Navigating to new session - reset refs to allow sessionId generation
      commandSentRef.current = null;
      sessionIdSetRef.current = null;
    } else if (sessionId && sessionId !== previousSessionId) {
      // SessionId changed to a new value - reset commandSentRef so we create/send command for new session
      commandSentRef.current = null;
      sessionIdSetRef.current = sessionId;
    } else if (sessionId) {
      // SessionId exists and hasn't changed - just update sessionIdSetRef
      sessionIdSetRef.current = sessionId;
    }
  }, [active, sessionId]);

  // If active but no session ID in URL, generate one and update the URL
  useEffect(() => {
    if (active && !sessionId && sessionIdSetRef.current === null) {
      const newSessionId = crypto.randomUUID();
      sessionIdSetRef.current = newSessionId;
      navigation.openDock(DockPointer.forNewCodingAgentCli(newSessionId));
    }
  }, [active, sessionId, navigation]);

  // Create Claude CLI session and start claude command when view becomes active
  useEffect(() => {
    const createClaudeSession = async () => {
      if (active && sessionId && commandSentRef.current !== sessionId) {
        const cn = dataContext.computeNode;
        if (!cn) return;

        // Check if Shell entity already exists for this session
        let shell: Shell | null = null;
        try {
          shell = await Shell.getById<Shell>(sessionId);
        } catch {
          // Not found
        }

        if (!shell) {
          shell = Shell.create(cn, { name: 'Claude CLI' });
          (shell as any).id = sessionId;
          await shell.save(cn.typeId);
          await shell.connect({ cols: 80, rows: 24 });

          // Wait for PTY to be live before sending command
          const waitForPtyReady = () => {
            if (shell!.connected) {
              void (async () => {
                try {
                  await shell!.sendInput(`claude --debug --session-id ${sessionId}\r\n`);
                  commandSentRef.current = sessionId;
                } catch (e) {
                  console.error('[CodingAgentView] Failed to send claude command:', e);
                }
              })();
            } else {
              setTimeout(waitForPtyReady, 200);
            }
          };
          setTimeout(waitForPtyReady, 500);
        }
      }
    };
    void createClaudeSession();
  }, [active, sessionId]);

  if (!sessionId) {
    return <div className="flex h-full items-center justify-center">No session ID</div>;
  }

  return (
    <div className="flex h-full gap-2 p-2">
      <div className="flex-1 overflow-hidden rounded-md border bg-background">
        <InteractiveTerminal sessionId={sessionId} flow={flow} className="h-full" active={active} />
      </div>
    </div>
  );
}
