import { AgenticProcess, Shell, type TabRow, Tab, TypeId } from '@sdk';
import { useEntity } from '@src/hooks/entity-hooks';
import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import { ClaudeIcon } from '@src/components/icons/ClaudeIcon';
import { Button } from '@src/components/ui/button';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useTerminalTabRows } from '@src/tabs/useTabs';
import { useTerminalStripController } from '@src/tabs/useTerminalStripController';
import { History, Loader2, SquareTerminal } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import InteractiveTerminal from './interactive-terminal';
import { TerminalRuntimeErrorBanner } from './interactive-terminal/TerminalRuntimeErrorBanner';
import { allowRename, shouldAutoSaveTitleForTarget } from './rename-rules';

interface TabbedTerminalProps {
  className?: string;
  /** Which terminals the body keeps warm-mounted: the active project +
   *  projectless (`'project'`, default) or every project (`'all'`, the dev
   *  sessions view). Matches the `scope` passed to the host's `UnifiedTabStrip`. */
  scope?: 'project' | 'all';
  /** Pin spawned shells/processes to this project (CollaborationSpace / dev view);
   *  otherwise the active project. */
  spawnProjectId?: string | null;
}

/**
 * One warm-mounted terminal panel. Renders from a `TabRow` plus its OWN live
 * entity (URL-first corollary: the view hydrates + attaches on mount, not via a
 * list-wide join). A process panel resolves its transport shell from the live
 * `AgenticProcess.shell_id` (so a worker restart reconnects the PTY); a plain
 * shell's transport is its target id. The OSC title auto-save saves the live
 * entity and mirrors the label onto the Tab via `set_name` (no `auto_rename` pin).
 */
const TerminalPanel: React.FC<{
  row: TabRow;
  isActive: boolean;
  isMounted: boolean;
  flow: AgenticProcess | null;
}> = ({ row, isActive, isMounted, flow }) => {
  const isProcess = row.target_type === AgenticProcess.type;
  const targetId = row.target_id ?? '';
  const { data: process } = useEntity<AgenticProcess>(
    isProcess && targetId ? new TypeId(AgenticProcess.type, targetId) : null,
  );
  const { data: shell } = useEntity<Shell>(
    !isProcess && targetId ? new TypeId(Shell.type, targetId) : null,
  );
  const transportShellId = isProcess ? (process?.shell_id ?? '') : targetId;
  const source = isProcess ? process : shell;

  const handleTitleChange = (title: string): void => {
    if (row.is_disabled) return;
    if (!shouldAutoSaveTitleForTarget(row.target_type, isProcess ? process : null)) return;
    if (!source || !source.auto_rename) return; // user pinned this tab
    if (!allowRename(title) || source.name === title) return;
    source.name = title;
    void source.save().catch(() => {});
    // Mirror onto the durable Tab label so the chip stays right once inactive —
    // set_name, NOT rename (which would pin auto_rename off).
    void Tab.setNameById(row.id, title).catch(() => {});
  };

  return (
    <div
      data-testid="terminal-panel"
      data-session-id={row.pointer}
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
            process={isProcess ? (process ?? undefined) : undefined}
            onTitleChange={handleTitleChange}
          />
        ) : isProcess && !process ? null /* process entity still hydrating */ : (
          // Process loaded but has no shell (worker binary missing / start_failure):
          // a clear error + Retry instead of a silent blank panel.
          <TerminalRuntimeErrorBanner />
        ))}
    </div>
  );
};

/**
 * TabbedTerminal — the terminal BODY (docs/tab-management.md). It renders only the
 * warm-mounted terminal panels; the chip strip is the shared `UnifiedTabStrip` the
 * host renders above it. Rows come from the one backend-authoritative source
 * (`useTerminalTabRows` → `tab` action), the active panel is URL-derived, and each
 * panel hydrates its own entity on mount. The empty state offers the spawn openers
 * (via the chrome controller).
 */
const TabbedTerminal: React.FC<TabbedTerminalProps> = ({
  className = '',
  scope = 'project',
  spawnProjectId,
}) => {
  const { flow } = useAgentContext();
  const { currentDock } = useDockNavigation();
  const rows = useTerminalTabRows(scope, spawnProjectId);

  // Active panel = the URL (every row is keyed by its `pointer` == tabHash). A
  // non-terminal dock's tabHash never matches a terminal row, so no special-case.
  const activeKey = currentDock?.tabHash ?? '';

  // Lazy-mount: mount the active panel on first visit; keep mounted ones warm
  // (the Set never shrinks) so re-activation is instant.
  const [mounted, setMounted] = useState<Set<string>>(() => new Set(activeKey ? [activeKey] : []));
  useEffect(() => {
    if (!activeKey) return;
    setMounted((prev) => {
      if (prev.has(activeKey)) return prev;
      const next = new Set(prev);
      next.add(activeKey);
      return next;
    });
  }, [activeKey]);

  // Chrome controller — spawn openers + modals only (the strip owns shortcuts).
  const controller = useTerminalStripController({ spawnProjectId });
  const {
    modals,
    isTabCreationPending,
    isClaudeCreationPending,
    isTerminalCreationPending,
    handleStartClaude,
    handleStartTerminal,
    handleOpenHistory,
  } = controller;

  return (
    <div className={`flex h-full ${className}`}>
      <div className="flex h-full w-full flex-col">
        <div className="relative flex-1 overflow-hidden" data-testid="terminal-panels">
          {rows.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-4 text-muted-foreground">
              <p className="text-sm">No terminal sessions</p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-2"
                  onClick={() => void handleStartClaude()}
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
                  onClick={() => void handleStartTerminal()}
                  disabled={isTabCreationPending}
                >
                  {isTerminalCreationPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <SquareTerminal className="h-4 w-4" />
                  )}
                  Terminal
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-2"
                  onClick={handleOpenHistory}
                  disabled={isTabCreationPending}
                  data-testid="open-history-button"
                >
                  <History className="h-4 w-4" />
                  Open from history
                </Button>
              </div>
            </div>
          ) : (
            rows.map((row) => (
              <TerminalPanel
                key={row.pointer}
                row={row}
                isActive={row.pointer === activeKey}
                isMounted={mounted.has(row.pointer)}
                flow={flow ?? null}
              />
            ))
          )}
        </div>
      </div>
      {modals}
    </div>
  );
};

export default TabbedTerminal;
