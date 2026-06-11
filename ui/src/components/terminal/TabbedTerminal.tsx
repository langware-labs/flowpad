import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import { ClaudeIcon } from '@src/components/icons/ClaudeIcon';
import { Button } from '@src/components/ui/button';
import { TabStrip } from '@src/components/tabs/TabStrip';
import {
  terminalProcessId,
  terminalTargetKey,
  terminalTransportShellId,
  type TerminalTab,
} from '@src/tabs/useTabs';
import {
  shouldAutoSavePtyTitle,
  useTerminalStripController,
} from '@src/tabs/useTerminalStripController';
import { Loader2, SquareTerminal } from 'lucide-react';
import React from 'react';
import InteractiveTerminal from './interactive-terminal';
import { TerminalRuntimeErrorBanner } from './interactive-terminal/TerminalRuntimeErrorBanner';

interface TabbedTerminalProps {
  className?: string;
  /** Whether to show the "Add Tab" button (default: false) */
  addTabButton?: boolean;
  /** When set, only shells shared into this collaboration room are shown. */
  collaborationRoomId?: string | null;
  /**
   * When set, new shells/processes created from this tab strip are pinned to
   * this project_id (not `dataContext.project?.id` at click time). Used by the
   * CollaborationSpace view to prevent the active project context leaking into
   * a process that belongs to the space's project.
   */
  spawnProjectId?: string | null;
  /**
   * Fires when the user clicks a tab. The consumer performs navigation; the
   * component never calls navigation.openDock for tab clicks itself.
   */
  onTabClick?: (targetKey: string, session: TerminalTab) => void;
  /**
   * Fires after a tab's close has been committed to the backend (shell status
   * transitions to CLOSED). The consumer decides where to navigate next.
   */
  onTabClose?: (targetKey: string | string[]) => void;
  /**
   * Fires after a new tab has been created (Shell/AgenticProcess persisted).
   * The consumer decides the destination URL.
   */
  onTabOpen?: (session: TerminalTab) => void;
  /**
   * Render the embedded tab strip (default: true). The content panel passes
   * false because the unified TabStrip in its header already renders the
   * terminal section — a second embedded strip would double up
   * (tab-management.md Part 3 §6). Keyboard shortcuts follow the strip: the
   * strip owner registers them.
   */
  showStrip?: boolean;
}

/** Find the first available "Tab N" name, filling gaps from closed tabs. */
export function nextTerminalName(sessions: { name: string }[]): string {
  const usedNumbers = new Set<number>();
  sessions.forEach((s) => {
    const match = s.name.match(/^Tab (\d+)$/);
    if (match) usedNumbers.add(parseInt(match[1], 10));
  });
  let n = 1;
  while (usedNumbers.has(n)) n++;
  return `Tab ${n}`;
}

/**
 * TabbedTerminal - Multi-tab terminal interface
 *
 * Thin composition over `useTerminalStripController` (the extracted strip
 * controller — data, active-key derivation, self-heal, creation/close/rename/
 * popout strategies, shortcuts) + the generic TabStrip + lazy-mounted
 * terminal panels + the controller's modals.
 *
 * Active tab is URL-derived (controller). Tab clicks navigate via
 * navigation.openDock(entity.dockPointer) in the consumer's onTabClick.
 * All flags and statuses come from Shell / AgenticProcess entities via the
 * unified tabs store.
 */
const TabbedTerminal: React.FC<TabbedTerminalProps> = ({
  className = '',
  addTabButton,
  collaborationRoomId,
  spawnProjectId,
  onTabClick,
  onTabClose,
  onTabOpen,
  showStrip = true,
}) => {
  const { flow } = useAgentContext();
  const controller = useTerminalStripController({
    addTabButton,
    collaborationRoomId,
    spawnProjectId,
    onTabClick,
    onTabClose,
    onTabOpen,
    // The strip owner owns the window shortcuts; with the strip hidden the
    // unified content-panel strip's controller registers them instead.
    enableShortcuts: showStrip,
  });
  const {
    visibleSessions,
    activeTargetKey,
    mountedTargetKeys,
    contextAgenticProcess,
    onTabRename,
    isTabCreationPending,
    isClaudeCreationPending,
    isTerminalCreationPending,
    handleStartClaude,
    handleStartTerminal,
  } = controller;

  return (
    <div className={`flex h-full ${className}`}>
      {/* Main terminal area */}
      <div className="flex h-full w-full flex-col">
        {/* Tab Bar — the generic TabStrip; the controller's handlers are the
            terminal kind strategies: close = backend teardown (batched),
            rename = entity save + PTY /rename, popout = external browser +
            resolver detach (Part 3 §3/§6). */}
        {showStrip && (
          <TabStrip
            items={controller.stripItems}
            activeKey={activeTargetKey}
            onSelect={controller.handleSelect}
            onClose={controller.handleCloseTab}
            onCloseMany={controller.handleCloseMany}
            onRename={controller.handleRenameCommit}
            onPopout={controller.handleOpenExternalTab}
            newTabMenuItems={controller.newTabMenuItems}
            closeShortcutLabel={controller.closeShortcutLabel}
            leading={controller.leading}
            trailing={controller.trailing}
          />
        )}

        {/* Terminal Content - Lazy-mount: only render InteractiveTerminal for
             sessions that have been active at least once (mountedTargetKeys).
             Inactive never-visited sessions render a cheap placeholder div.
             Keep all terminals mounted — once mounted, terminals stay alive; inactive ones are
             hidden via visibility:hidden so their canvas is preserved for instant re-activation. */}
        <div className="relative flex-1 overflow-hidden" data-testid="terminal-panels">
          {visibleSessions.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-4 text-muted-foreground">
              <p className="text-sm">No terminal sessions</p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-2"
                  onClick={() => {
                    void handleStartClaude();
                  }}
                  disabled={isTabCreationPending}
                  data-testid="start-claude-button"
                >
                  {isClaudeCreationPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <ClaudeIcon className="h-4 w-4 text-orange-500" />
                  )}
                  Claude Code
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-2"
                  onClick={() => {
                    void handleStartTerminal();
                  }}
                  disabled={isTabCreationPending}
                >
                  {isTerminalCreationPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <SquareTerminal className="h-4 w-4" />
                  )}
                  Terminal
                </Button>
              </div>
            </div>
          ) : (
            visibleSessions.map((session) => {
              const targetKey = terminalTargetKey(session);
              const transportShellId = terminalTransportShellId(session);
              const isActive = activeTargetKey === targetKey;
              const isMounted = mountedTargetKeys.has(targetKey);
              const sessionProcess =
                terminalProcessId(session) && contextAgenticProcess?.id === terminalProcessId(session)
                  ? contextAgenticProcess
                  : session.agenticProcess;
              const autoSavePtyTitle = shouldAutoSavePtyTitle(session, sessionProcess);

              return (
                <div
                  key={targetKey}
                  data-testid="terminal-panel"
                  data-session-id={targetKey}
                  data-active={isActive ? 'true' : 'false'}
                  className="absolute inset-0 min-h-0 overflow-hidden"
                  style={isActive ? { zIndex: 1 } : { visibility: 'hidden', zIndex: 0 }}
                >
                  {isMounted &&
                    (transportShellId ? (
                      <InteractiveTerminal
                        sessionId={transportShellId}
                        flow={flow}
                        className="h-full"
                        active={isActive}
                        process={sessionProcess}
                        onTitleChange={
                          autoSavePtyTitle
                            ? (title) => {
                                if (session.isDisabled) return;
                                onTabRename(session, title, true, sessionProcess);
                              }
                            : undefined
                        }
                      />
                    ) : (
                      // No shell behind this tab (e.g. worker binary missing →
                      // start_failure latched, shell_id cleared). InteractiveTerminal
                      // can't mount, so render the runtime-error banner standalone —
                      // a clear error + Retry instead of a silent blank panel.
                      <TerminalRuntimeErrorBanner />
                    ))}
                </div>
              );
            })
          )}
        </div>
      </div>
      {controller.modals}
    </div>
  );
};

export default TabbedTerminal;
