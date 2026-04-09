import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import { useActiveTerminals } from '@src/hooks/useActiveTerminals';
import { dataContext, isProcessLive, ShellStatus, type AgenticProcess } from '@sdk';
import { useContext } from '@src/hooks/useContext';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { Button } from '@src/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@src/components/ui/context-menu';
import { ChevronLeft, ChevronRight, FolderGit2, Loader2, SquareTerminal, X, XCircle } from 'lucide-react';
import { ClaudeIcon } from '@src/components/icons/ClaudeIcon';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import InteractiveTerminal from './interactive-terminal';
import { useDockNavigation } from '@src/navigation/useDockNavigation';

interface TabbedTerminalProps {
  className?: string;
  /** Whether to show the "Add Tab" button (default: false) */
  addTabButton?: boolean;
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

function timeAgo(date: Date | string | undefined | null): string {
  if (!date) return '—';
  const d = typeof date === 'string' ? new Date(date) : date;
  const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatDateTime(date: Date | string | undefined | null): string {
  if (!date) return '—';
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

const ProcessInfoTooltip: React.FC<{ process: AgenticProcess; statusReason?: string }> = ({ process, statusReason }) => {
  const workdir = process.workdir;
  const isActive = process.is_active;
  const status = isProcessLive(process.status) ? process.workerStatus : process.status;
  const workerSessionId = process.session_id ?? null;

  return (
    <div className="space-y-1.5 min-w-[220px]">
      {statusReason && (
        <p className="text-amber-500 text-[11px]">{statusReason}</p>
      )}
      <div className="flex items-center gap-2">
        <span className={`inline-block h-1.5 w-1.5 rounded-full shrink-0 ${isActive ? 'bg-emerald-500' : 'bg-muted-foreground'}`} />
        <span className="capitalize text-[11px] font-semibold text-foreground">{status}</span>
      </div>
      {workdir && (
        <p className="text-[10px] text-muted-foreground font-mono truncate max-w-[240px]" title={workdir}>
          {workdir}
        </p>
      )}
      <div className="border-t pt-1.5 space-y-1">
        <InfoRow label="Created" value={`${formatDateTime(process.created_date)} · ${timeAgo(process.created_date)}`} />
        <InfoRow label="Updated" value={`${formatDateTime(process.updated_date)} · ${timeAgo(process.updated_date)}`} />
        {workerSessionId && (
          <InfoRow label="Session" value={workerSessionId.slice(0, 8) + '…'} />
        )}
      </div>
    </div>
  );
};

const InfoRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex items-baseline gap-2">
    <span className="text-[10px] text-muted-foreground w-14 shrink-0">{label}</span>
    <span className="text-[10px] text-foreground">{value}</span>
  </div>
);

/**
 * TabbedTerminal - Multi-tab terminal interface
 *
 * Active tab is set by the loader (dataContext.activeShellId / agenticProcessTypeId).
 * Tab clicks navigate via navigation.openDock(entity.dockPointer), which re-runs the loader.
 * All flags and statuses come from Shell / AgenticProcess entities via useActiveTerminals.
 */
const TabbedTerminal: React.FC<TabbedTerminalProps> = ({ className = '', addTabButton }) => {
  const { tabs: sessions } = useActiveTerminals();
  const { flow } = useAgentContext();
  const { activeShellId: contextShellId } = useContext();
  const _perfLoggedRef = useRef(false);
  if (!_perfLoggedRef.current) {
    _perfLoggedRef.current = true;
    const t0 = (window as Record<string, unknown>).__shellNavT0 as number | undefined;
    if (t0 !== undefined) console.log(`[PERF] +${(performance.now() - t0).toFixed(0)}ms TabbedTerminal first render (${sessions.length} sessions)`);
  }

  const tabCreationLockRef = useRef(false);
  const [editingShellId, setEditingShellId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [pendingTabCreation, setPendingTabCreation] = useState<{
    kind: 'claude' | 'terminal';
    targetShellId: string | null;
  } | null>(null);

  // Scroll state
  const tabContainerRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [hasTabOverflow, setHasTabOverflow] = useState(false);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const { navigation } = useDockNavigation();
  const visibleSessions = sessions;

  // Active tab: set by the loader via dataContext.setActiveShellId.
  // Fall back to first tab if context has no selection yet (e.g. /dock/shell with no pointer).
  const activeShellId = (contextShellId ? contextShellId : visibleSessions[0]?.shellId) || '';
  const hasActiveTab = Boolean(activeShellId && visibleSessions.some((session) => session.shellId === activeShellId));

  // Lazy-mount: only render InteractiveTerminal for sessions that have been
  // active at least once. Inactive sessions that were never visited render a
  // cheap placeholder <div>. Once mounted the component stays alive (the Set
  // never shrinks) so subsequent tab switches are instant.
  const [mountedShellIds, setMountedShellIds] = useState<Set<string>>(
    () => new Set(activeShellId ? [activeShellId] : []),
  );
  useEffect(() => {
    if (!activeShellId) return;
    setMountedShellIds((prev) => {
      if (prev.has(activeShellId)) return prev;
      const next = new Set(prev);
      next.add(activeShellId);
      return next;
    });
  }, [activeShellId]);

  // Keep dataContext in sync for other consumers
  useEffect(() => {
    if (activeShellId) dataContext.setActiveShellId(activeShellId);
  }, [activeShellId]);

  const clearPendingTabCreation = useCallback(() => {
    tabCreationLockRef.current = false;
    setPendingTabCreation(null);
  }, []);

  // "Start Claude" button — creates AgenticProcess entity then navigates to it
  const handleStartClaude = useCallback(async () => {
    if (tabCreationLockRef.current) return;
    tabCreationLockRef.current = true;
    setPendingTabCreation({ kind: 'claude', targetShellId: null });
    const result = await navigation.openNewClaudeProcess();
    if (!result?.shellId) {
      clearPendingTabCreation();
      return;
    }
    // Set pending tab first so the tab strip shows the new tab immediately,
    // then navigate — keeping openDock outside the async spawn body prevents
    // React Router from cancelling the navigation due to in-flight re-renders.
    setPendingTabCreation({ kind: 'claude', targetShellId: result.shellId });
    navigation.openDock(result.dockPointer);
  }, [clearPendingTabCreation, navigation]);

  const handleStartTerminal = useCallback(async () => {
    if (tabCreationLockRef.current) return;
    tabCreationLockRef.current = true;
    setPendingTabCreation({ kind: 'terminal', targetShellId: null });
    const result = await navigation.openNewShell();
    if (!result?.shellId) {
      clearPendingTabCreation();
      return;
    }
    setPendingTabCreation({ kind: 'terminal', targetShellId: result.shellId });
  }, [clearPendingTabCreation, navigation]);

  // Navigate to a tab via its entity's dockPointer
  const navigateToSession = useCallback(
    (shellId: string) => {
      const session = sessions.find((s) => s.shellId === shellId);
      if (!session) return;
      // Set activeShellId immediately so the CSS display toggle happens
      // before the loader's async work (entity queries). The loader will
      // later call setActiveShellId with the same value (no-op).
      dataContext.setActiveShellId(shellId);
      const entity = session.agenticProcess ?? session.shell;
      if (entity) navigation.openDock(entity.dockPointer);
    },
    [sessions, navigation],
  );

  const scrollSelectedTabIntoView = useCallback((shellId: string) => {
    const container = tabContainerRef.current;
    const tab = tabRefs.current[shellId];
    if (!container || !tab) return;

    const tabLeft = tab.offsetLeft;
    const tabRight = tabLeft + tab.offsetWidth;
    const visibleLeft = container.scrollLeft;
    const visibleRight = visibleLeft + container.clientWidth;

    if (tabLeft < visibleLeft) {
      container.scrollTo({
        left: tabLeft,
        behavior: 'smooth',
      });
      return;
    }

    if (tabRight > visibleRight) {
      container.scrollTo({
        left: tabRight - container.clientWidth,
        behavior: 'smooth',
      });
    }
  }, []);

  const selectTab = useCallback(
    (shellId: string, options?: { navigate?: boolean }) => {
      if (!shellId) return;

      if (options?.navigate !== false) {
        navigateToSession(shellId);
      }

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          scrollSelectedTabIntoView(shellId);
        });
      });
    },
    [navigateToSession, scrollSelectedTabIntoView],
  );

  useEffect(() => {
    if (!pendingTabCreation?.targetShellId) return;
    const session = visibleSessions.find((s) => s.shellId === pendingTabCreation.targetShellId);
    if (session) {
      dataContext.setActiveShellId(session.shellId);
      clearPendingTabCreation();
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          scrollSelectedTabIntoView(session.shellId);
        });
      });
    }
  }, [visibleSessions, pendingTabCreation, clearPendingTabCreation, scrollSelectedTabIntoView]);

  useEffect(() => {
    if (!activeShellId || !hasActiveTab) return;
    selectTab(activeShellId, { navigate: false });
  }, [activeShellId, hasActiveTab, hasTabOverflow, canScrollLeft, selectTab]);

  const closeTab = useCallback(
    async (shellId: string): Promise<void> => {
      const session = sessions.find((s) => s.shellId === shellId);
      if (!session) return;
      try {
        if (session.agenticProcess) {
          await session.agenticProcess.close();
        } else if (session.shell) {
          await session.shell.close();
        }
      } catch (error) {
        console.error('[TabbedTerminal] Failed to close tab:', shellId, error);
      }
    },
    [sessions],
  );

  const handleCloseTab = useCallback(
    (shellId: string) => {
      if (activeShellId === shellId) {
        const idx = visibleSessions.findIndex((s) => s.shellId === shellId);
        const remaining = visibleSessions.filter((s) => s.shellId !== shellId && !s.isDisabled);
        remaining.length > 0 ? selectTab(remaining[Math.min(idx, remaining.length - 1)].shellId) : navigation.openShellView();
      }
      void closeTab(shellId);
    },
    [activeShellId, visibleSessions, closeTab, selectTab, navigation],
  );

  const handleCloseAll = useCallback(() => {
    void Promise.all(visibleSessions.map((s) => closeTab(s.shellId)));
    navigation.openShellView();
  }, [visibleSessions, closeTab, navigation]);

  const handleCloseAllButThis = useCallback(
    (shellId: string) => {
      void Promise.all(visibleSessions.filter((s) => s.shellId !== shellId).map((s) => closeTab(s.shellId)));
      selectTab(shellId);
    },
    [visibleSessions, closeTab, selectTab],
  );

  const handleCloseToTheRight = useCallback(
    (shellId: string) => {
      const idx = visibleSessions.findIndex((s) => s.shellId === shellId);
      const toClose = visibleSessions.slice(idx + 1);
      void Promise.all(toClose.map((s) => closeTab(s.shellId)));
      if (toClose.some((s) => s.shellId === activeShellId)) selectTab(shellId);
    },
    [visibleSessions, activeShellId, closeTab, selectTab],
  );

  const handleTabDoubleClick = (shellId: string, currentName: string) => {
    setEditingShellId(shellId);
    setEditingName(currentName);
  };

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setEditingName(e.target.value);
  };

  const handleNameBlur = () => {
    if (editingShellId && editingName.trim()) {
      const session = visibleSessions.find((s) => s.shellId === editingShellId);
      if (session?.shell) onTabRename(session, editingName.trim());
    }
    setEditingShellId(null);
  };

  const handleNameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      handleNameBlur();
    } else if (e.key === 'Escape') {
      setEditingShellId(null);
    }
  };

  const onTabRename = (session: (typeof visibleSessions)[number], newName: string, injectRename = true): void => {
    const shell = session.shell;
    if (!shell) return;

    // Rule 5: skip if no change
    if (shell.name === newName) return;

    // Guard: reject TypeId-formatted strings (e.g. "claude-<uuid>", "shell-<uuid>")
    if (/^[a-z][a-z0-9-]*-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(newName)) return;

    // PTY title changes must not override an explicit user rename.
    // user_renamed is set by the backend when the user runs /rename in CC or
    // renames via the UI dialog.
    if (!injectRename && shell.user_renamed) return;

    void shell.updateDisplay({ name: newName, is_pty: !injectRename });

    // Inject /rename only when user-initiated AND Claude is at the prompt (waiting_for_prompt),
    // never when the title came from xterm (PTY escape sequence), to avoid a loop
    // where Claude sets the title → we inject /rename → Claude sets the title again.
    if (injectRename && session.agenticProcess?.waiting_for_prompt) {
      void shell.sendInput(`/rename ${newName}\r`);
    }
  };

  // Get display name for a session
  const getDisplayName = (session: { shellId: string; name: string | null }): string => {
    return (typeof session.name === 'string' && session.name) ? session.name : session.shellId;
  };

  // Check if tabs overflow and update scroll button state
  const updateScrollState = () => {
    const container = tabContainerRef.current;
    if (!container) return;

    const { scrollLeft, scrollWidth, clientWidth } = container;
    const hasOverflow = scrollWidth > clientWidth + 1;
    setHasTabOverflow(hasOverflow);
    setCanScrollLeft(scrollLeft > 0);
    setCanScrollRight(hasOverflow && scrollLeft + clientWidth < scrollWidth - 1);
  };

  // Scroll tabs left or right
  const scrollTabs = (direction: 'left' | 'right') => {
    const container = tabContainerRef.current;
    if (!container) return;

    const scrollAmount = 200; // pixels to scroll
    container.scrollBy({
      left: direction === 'left' ? -scrollAmount : scrollAmount,
      behavior: 'smooth',
    });
  };

  // Update scroll state on mount, session changes, and scroll events
  useEffect(() => {
    updateScrollState();
    const container = tabContainerRef.current;
    if (!container) return;

    const handleScroll = () => updateScrollState();
    container.addEventListener('scroll', handleScroll);
    window.addEventListener('resize', updateScrollState);

    return () => {
      container.removeEventListener('scroll', handleScroll);
      window.removeEventListener('resize', updateScrollState);
    };
  }, [visibleSessions]);

  // Use Ctrl key on Mac, Win key on Windows, Alt key on Linux
  const osPlatform: string = (navigator as Navigator & { userAgentData?: { platform: string } }).userAgentData?.platform ?? navigator.userAgent;
  const modKey = /Mac/i.test(osPlatform) ? 'Ctrl' : /Win/i.test(osPlatform) ? 'Meta' : 'Alt';
  const modLabel = /Mac/i.test(osPlatform) ? 'Ctrl' : /Win/i.test(osPlatform) ? 'Win' : 'Alt';

  // Intercept mod+W (close tab), mod+T (new Claude), mod+PgUp/PgDn (cycle tabs)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const modPressed = modKey === 'Ctrl' ? e.ctrlKey : modKey === 'Meta' ? e.metaKey : e.altKey;
      if (!modPressed) return;
      if (e.key === 'w' || e.key === 'W') {
        e.preventDefault();
        void handleCloseTab(activeShellId);
      } else if (e.key === 't' || e.key === 'T') {
        e.preventDefault();
        void handleStartClaude();
      } else if (e.key === 'PageUp') {
        e.preventDefault();
        const idx = visibleSessions.findIndex((s) => s.shellId === activeShellId);
        if (idx > 0) selectTab(visibleSessions[idx - 1].shellId);
      } else if (e.key === 'PageDown') {
        e.preventDefault();
        const idx = visibleSessions.findIndex((s) => s.shellId === activeShellId);
        if (idx < visibleSessions.length - 1) selectTab(visibleSessions[idx + 1].shellId);
      }
    };
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [activeShellId, handleStartTerminal, handleStartClaude, visibleSessions, selectTab, handleCloseTab, modKey]);

  const isTabCreationPending = pendingTabCreation !== null;
  const isClaudeCreationPending = pendingTabCreation?.kind === 'claude';
  const isTerminalCreationPending = pendingTabCreation?.kind === 'terminal';
  const tabEndToolbar = addTabButton ? (
    <div className="flex shrink-0 items-center gap-1 border-l px-1" data-testid="terminal-tab-end-toolbar">
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 rounded"
        onClick={handleStartClaude}
        disabled={isTabCreationPending}
        aria-busy={isClaudeCreationPending}
        aria-label={isClaudeCreationPending ? 'Starting Claude session' : 'Start Claude'}
        data-testid="start-claude-button"
        data-state={isClaudeCreationPending ? 'waiting' : 'idle'}
        title={isClaudeCreationPending ? 'Starting Claude session...' : `Start Claude (${modLabel}+C)`}
      >
        {isClaudeCreationPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ClaudeIcon className="h-4 w-4 text-orange-500" />}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 rounded"
        onClick={handleStartTerminal}
        disabled={isTabCreationPending}
        aria-busy={isTerminalCreationPending}
        aria-label={isTerminalCreationPending ? 'Opening terminal' : 'Open terminal'}
        data-testid="open-terminal-tab-button"
        data-state={isTerminalCreationPending ? 'waiting' : 'idle'}
        title={isTerminalCreationPending ? 'Opening terminal...' : `Open terminal (${modLabel}+T)`}
      >
        {isTerminalCreationPending ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <SquareTerminal className="h-4 w-4" />
        )}
      </Button>
    </div>
  ) : null;

  return (
    <div className={`flex h-full ${className}`}>
      {/* Main terminal area */}
      <div className="flex h-full w-full flex-col">
        {/* Tab Bar */}
        <div className="flex items-center border-b bg-muted/30" data-testid="terminal-tab-bar">
          {/* Left Scroll Button */}
          {canScrollLeft && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0 rounded-none"
              onClick={() => scrollTabs('left')}
              aria-label="Scroll tabs left"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
          )}

          {/* Scrollable Tab Container */}
          <div
            ref={tabContainerRef}
            data-testid="terminal-tabs-scroll-container"
            className="scrollbar-hide flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-2 py-1"
            style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
          >
            {visibleSessions.map((session, index) => {
              const displayName = getDisplayName(session);
              const isDisabled = session.isDisabled;
              const isClosing = session.shell?.status === ShellStatus.CLOSING;

              const tabContent = (
                <div
                  ref={(node) => {
                    tabRefs.current[session.shellId] = node;
                  }}
                  className={`group flex shrink-0 select-none items-center gap-2 rounded-t border-b-2 px-3 py-1.5 transition-colors ${
                    isDisabled
                      ? 'cursor-not-allowed border-transparent bg-muted/30 text-muted-foreground/50'
                      : activeShellId === session.shellId
                        ? 'cursor-pointer border-primary bg-background text-foreground'
                        : 'cursor-pointer border-transparent bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground'
                  } `}
                  onClick={() => !isDisabled && selectTab(session.shellId)}
                  data-testid={`tab-shell-${session.shellId}`}
                >
                  {/* Status dot */}
                  <span
                    className={`inline-block h-2 w-2 shrink-0 rounded-full ${
                      isClosing ? 'bg-amber-500/70' : isDisabled ? 'bg-red-500/70' : 'bg-green-500/70'
                    }`}
                  />
                  {Boolean(session.agenticProcess?.cliOptions?.worktree) && (
                    <FolderGit2 className="h-3 w-3 shrink-0 text-amber-500" />
                  )}
                  {editingShellId === session.shellId ? (
                    <input
                      type="text"
                      value={editingName}
                      onChange={handleNameChange}
                      onBlur={handleNameBlur}
                      onKeyDown={handleNameKeyDown}
                      className="min-w-[80px] rounded border border-border bg-background px-1 py-0 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                      autoFocus
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <span
                      className="text-sm font-medium"
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        handleTabDoubleClick(session.shellId, displayName);
                      }}
                    >
                      {displayName}
                    </span>
                  )}

                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleCloseTab(session.shellId);
                    }}
                    disabled={isDisabled}
                    className="rounded p-0.5 opacity-0 transition-opacity hover:bg-destructive/20 group-hover:opacity-100"
                    aria-label="Close tab"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              );

              return (
                <ContextMenu key={session.shellId}>
                  <TooltipProvider delayDuration={600}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <ContextMenuTrigger asChild>
                        {tabContent}
                      </ContextMenuTrigger>
                    </TooltipTrigger>
                    {session.agenticProcess ? (
                      <TooltipContent side="bottom" className="p-2.5 bg-popover text-popover-foreground border shadow-md">
                        <ProcessInfoTooltip
                          process={session.agenticProcess}
                          statusReason={isDisabled ? session.statusReason : undefined}
                        />
                      </TooltipContent>
                    ) : isDisabled ? (
                      <TooltipContent side="bottom">{session.statusReason}</TooltipContent>
                    ) : null}
                  </Tooltip>
                  </TooltipProvider>
                  <ContextMenuContent>
                    <ContextMenuItem onSelect={() => handleTabDoubleClick(session.shellId, displayName)}>Rename</ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem onSelect={() => void handleStartClaude()}>
                      New Claude Session <span className="ml-auto pl-4 text-xs text-muted-foreground">{modLabel}+C</span>
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={() => void handleStartTerminal()}>
                      New Terminal <span className="ml-auto pl-4 text-xs text-muted-foreground">{modLabel}+T</span>
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem onSelect={() => handleCloseTab(session.shellId)}>
                      Close <span className="ml-auto pl-4 text-xs text-muted-foreground">{modLabel}+W</span>
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={handleCloseAll}>Close All</ContextMenuItem>
                    <ContextMenuItem
                      onSelect={() => handleCloseAllButThis(session.shellId)}
                      disabled={visibleSessions.length <= 1}
                    >
                      Close All But This
                    </ContextMenuItem>
                    <ContextMenuItem
                      onSelect={() => handleCloseToTheRight(session.shellId)}
                      disabled={index >= visibleSessions.length - 1}
                    >
                      Close to the Right
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              );
            })}

            {!hasTabOverflow && tabEndToolbar}

          </div>

          {/* Once tabs overflow, pin the end toolbar next to the right scroll control. */}
          {hasTabOverflow && tabEndToolbar}

          {/* Right Scroll Button */}
          {hasTabOverflow && (
            <Button
              variant="ghost"
              size="icon"
              className={`h-7 w-7 shrink-0 rounded-none ${canScrollRight ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
              onClick={() => scrollTabs('right')}
              aria-label="Scroll tabs right"
              data-testid="scroll-tabs-right-button"
              tabIndex={canScrollRight ? 0 : -1}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          )}

          {/* Close All button — shown when 2+ tabs are open */}
          {visibleSessions.length >= 2 && (
            <TooltipProvider delayDuration={600}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0 rounded-none text-muted-foreground hover:text-destructive"
                    onClick={handleCloseAll}
                    aria-label="Close all tabs"
                    data-testid="close-all-tabs-button"
                  >
                    <XCircle className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Close all tabs</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>

        {/* Terminal Content - Lazy-mount: only render InteractiveTerminal for
             sessions that have been active at least once (mountedShellIds).
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
                  onClick={handleStartClaude}
                  disabled={isTabCreationPending}
                >
                  {isClaudeCreationPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ClaudeIcon className="h-4 w-4 text-orange-500" />}
                  Claude Code
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-2"
                  onClick={handleStartTerminal}
                  disabled={isTabCreationPending}
                >
                  {isTerminalCreationPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <SquareTerminal className="h-4 w-4" />}
                  Terminal
                </Button>
              </div>
            </div>
          ) : (
            visibleSessions.map((session) => {
              const isActive = activeShellId === session.shellId;
              const isMounted = mountedShellIds.has(session.shellId);

              return (
                <div
                  key={session.shellId}
                  data-testid="terminal-panel"
                  data-session-id={`shell-${session.shellId}`}
                  data-active={isActive ? 'true' : 'false'}
                  className="absolute inset-0 min-h-0 overflow-hidden"
                  style={isActive ? { zIndex: 1 } : { visibility: 'hidden', zIndex: 0 }}
                >
                  {isMounted && (
                    <InteractiveTerminal
                      sessionId={session.shellId}
                      flow={flow}
                      className="h-full"
                      active={isActive}
                      onTitleChange={(title) => {
                        if (session.isDisabled) return;
                        onTabRename(session, title, false);
                      }}
                      process={session.agenticProcess}
                    />
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};

export default TabbedTerminal;
