import { AgenticProcess, dataContext, getDisplayStatus, isProcessRunning, isReadyForInput, ProcessStatus, Shell, ShellStatus, type ComputeNode } from '@sdk';
import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import { ClaudeIcon } from '@src/components/icons/ClaudeIcon';
import { Button } from '@src/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@src/components/ui/context-menu';
import { InputDialog } from '@src/components/ui/input-dialog';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { useResumeInTerminal } from '@src/hooks/use-resume-in-terminal';
import { useActiveTerminals } from '@src/hooks/useActiveTerminals';
import { useContext } from '@src/hooks/useContext';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import {
  ChevronLeft,
  ChevronRight,
  Cloud,
  Container,
  FolderGit2,
  History,
  Loader2,
  SquareTerminal,
  X,
  XCircle,
} from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { HistoryModal } from './HistoryModal';
import InteractiveTerminal from './interactive-terminal';
import { TerminalOpenerToolbar } from './openers/TerminalOpenerToolbar';
import type { OpenerDescriptor } from './openers/tab_opener_types';

const ClaudeResumeIcon: React.FC<{ className?: string }> = ({ className }) => (
  <span className={`relative inline-flex items-center justify-center ${className ?? ''}`}>
    <ClaudeIcon className="!h-4 !w-4 text-orange-500" />
    <History className="absolute -bottom-0.5 -right-0.5 !h-2.5 !w-2.5 text-foreground/80" strokeWidth={3} />
  </span>
);

import type { TerminalTab } from '@src/hooks/useActiveTerminals';

interface TabbedTerminalProps {
  className?: string;
  /** Whether to show the "Add Tab" button (default: false) */
  addTabButton?: boolean;
  /** When set, only shells shared into this collaboration space are shown. */
  collaborationSessionId?: string | null;
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
  onTabClick?: (shellId: string, session: TerminalTab) => void;
  /**
   * Fires after a tab's close has been committed to the backend (shell status
   * transitions to CLOSED). The consumer decides where to navigate next.
   */
  onTabClose?: (shellId: string) => void;
  /**
   * Fires after a new tab has been created (Shell/AgenticProcess persisted).
   * The consumer decides the destination URL.
   */
  onTabOpen?: (session: TerminalTab) => void;
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
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

const ProcessInfoTooltip: React.FC<{ process: AgenticProcess; statusReason?: string }> = ({
  process,
  statusReason,
}) => {
  const workdir = process.workdir;
  // "Alive" under the new model = the process container is in a running lifecycle state.
  const isAlive = isProcessRunning(process.status ?? ProcessStatus.NEW);
  const status = getDisplayStatus(process) ?? ProcessStatus.NEW;
  const workerSessionId = process.session_id ?? null;

  return (
    <div className="min-w-[220px] space-y-1.5">
      {statusReason && <p className="text-[11px] text-amber-500">{statusReason}</p>}
      <div className="flex items-center gap-2">
        <span
          className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${isAlive ? 'bg-emerald-500' : 'bg-muted-foreground'}`}
        />
        <span className="text-[11px] font-semibold capitalize text-foreground">{status}</span>
      </div>
      {workdir && (
        <p className="max-w-[240px] truncate font-mono text-[10px] text-muted-foreground" title={workdir}>
          {workdir}
        </p>
      )}
      <div className="space-y-1 border-t pt-1.5">
        <InfoRow label="Created" value={`${formatDateTime(process.created_date)} · ${timeAgo(process.created_date)}`} />
        <InfoRow label="Updated" value={`${formatDateTime(process.updated_date)} · ${timeAgo(process.updated_date)}`} />
        {workerSessionId && <InfoRow label="Session" value={workerSessionId.slice(0, 8) + '…'} />}
      </div>
    </div>
  );
};

const InfoRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex items-baseline gap-2">
    <span className="w-14 shrink-0 text-[10px] text-muted-foreground">{label}</span>
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
const TabbedTerminal: React.FC<TabbedTerminalProps> = ({
  className = '',
  addTabButton,
  collaborationSessionId,
  spawnProjectId,
  onTabClick,
  onTabClose,
  onTabOpen,
}) => {
  const { tabs: sessions } = useActiveTerminals({ collaborationSessionId });
  const { flow } = useAgentContext();
  const { activeShellId: contextShellId, agenticProcess: contextAgenticProcess } = useContext();
  const _perfLoggedRef = useRef(false);
  if (!_perfLoggedRef.current) {
    _perfLoggedRef.current = true;
    const t0 = (window as Record<string, unknown>).__shellNavT0 as number | undefined;
    if (t0 !== undefined)
      console.log(
        `[PERF] +${(performance.now() - t0).toFixed(0)}ms TabbedTerminal first render (${sessions.length} sessions)`,
      );
  }

  const tabCreationLockRef = useRef(false);
  const [editingShellId, setEditingShellId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [pendingTabCreation, setPendingTabCreation] = useState<{
    kind: 'claude' | 'terminal';
    targetShellId: string | null;
    targetProcessId: string | null;
  } | null>(null);

  // Scroll state
  const tabContainerRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [historyModalOpen, setHistoryModalOpen] = useState(false);
  const [resumeByIdOpen, setResumeByIdOpen] = useState(false);
  const { resumeInTerminal } = useResumeInTerminal();
  const [hasTabOverflow, setHasTabOverflow] = useState(false);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const { navigation } = useDockNavigation();
  const visibleSessions = sessions;

  // Active tab: set by the loader via dataContext.setActiveShellId.
  // Fall back to first tab if context has no selection yet (e.g. /dock/shell with no pointer).
  const activeShellId = (contextShellId ? contextShellId : visibleSessions[0]?.shellId) || '';
  const hasActiveTab = Boolean(activeShellId && visibleSessions.some((session) => session.shellId === activeShellId));

  // Lazy-mount: only mount the active terminal initially; mount others on
  // first switch. With many tabs (e.g. 69), eagerly mounting all of them
  // caused a 14-second main-thread freeze from 69 InteractiveTerminal
  // component trees (each with ~30 hooks, xterm init, addon loading).
  // The Set never shrinks so subsequent switches stay instant.
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

  // "Start Claude" button — creates AgenticProcess entity, then emits onTabOpen
  // so the consumer can navigate / tag / start.
  const handleStartClaude = useCallback(async () => {
    if (tabCreationLockRef.current) return;
    tabCreationLockRef.current = true;
    setPendingTabCreation({ kind: 'claude', targetShellId: null, targetProcessId: null });
    const result = await navigation.openNewClaudeProcess(
      spawnProjectId ? { projectId: spawnProjectId } : undefined,
    );
    if (!result) {
      clearPendingTabCreation();
      return;
    }
    setPendingTabCreation({
      kind: 'claude',
      targetShellId: result.shellId,
      targetProcessId: result.processId,
    });
    const agenticProcess =
      AgenticProcess.getByIdFromCache<AgenticProcess>(result.processId) ?? undefined;
    const shell =
      result.shellId
        ? Shell.getByIdFromCache<Shell>(result.shellId) ?? undefined
        : undefined;
    onTabOpen?.({
      shellId: result.shellId ?? '',
      tabOrder: shell?.tab_order ?? 0,
      name: shell?.name ?? null,
      type: 'claude',
      agenticProcess,
      shell,
      isDisabled: false,
      statusReason: '',
    });
  }, [clearPendingTabCreation, navigation, onTabOpen]);

  const startTerminalTab = useCallback(
    async (computeNode?: ComputeNode) => {
      if (tabCreationLockRef.current) return;
      tabCreationLockRef.current = true;
      setPendingTabCreation({ kind: 'terminal', targetShellId: null, targetProcessId: null });
      // skipNavigate: true — consumer owns destination via onTabOpen.
      const result = await navigation.openNewShell({
        ...(computeNode ? { computeNode } : {}),
        ...(spawnProjectId ? { projectId: spawnProjectId } : {}),
        skipNavigate: true,
      });
      if (!result?.shellId) {
        clearPendingTabCreation();
        return;
      }
      setPendingTabCreation({ kind: 'terminal', targetShellId: result.shellId, targetProcessId: null });
      const shell = Shell.getByIdFromCache<Shell>(result.shellId) ?? undefined;
      onTabOpen?.({
        shellId: result.shellId,
        tabOrder: shell?.tab_order ?? 0,
        name: shell?.name ?? null,
        type: 'plain',
        shell,
        isDisabled: false,
        statusReason: '',
      });
    },
    [clearPendingTabCreation, navigation, onTabOpen],
  );

  const handleStartTerminal = useCallback(() => startTerminalTab(), [startTerminalTab]);

  const handleStartSandbox = useCallback(() => {
    const sandboxNode = dataContext.sandboxComputeNode;
    if (!sandboxNode) return;
    return startTerminalTab(sandboxNode);
  }, [startTerminalTab]);

  const handleStartDocker = useCallback((dockerNode: ComputeNode) => startTerminalTab(dockerNode), [startTerminalTab]);

  // Navigate to a tab by emitting onTabClick — consumer owns the destination.
  // Uses sessionsRef to avoid re-creating the callback when the sessions
  // array identity changes (which cascades into selectTab → scroll effects).
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const navigateToSession = useCallback(
    (shellId: string) => {
      const session = sessionsRef.current.find((s) => s.shellId === shellId);
      if (!session) return;
      // Set activeShellId immediately so the CSS display toggle happens
      // before the loader's async work (entity queries). The loader will
      // later call setActiveShellId with the same value (no-op).
      dataContext.setActiveShellId(shellId);
      onTabClick?.(shellId, session);
    },
    [onTabClick],
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
    if (!pendingTabCreation) return;
    const session = visibleSessions.find((s) => {
      if (pendingTabCreation.targetShellId && s.shellId === pendingTabCreation.targetShellId) return true;
      if (pendingTabCreation.targetProcessId && s.agenticProcess?.id === pendingTabCreation.targetProcessId)
        return true;
      return false;
    });
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
    // scrollSelectedTabIntoView reads DOM on each call — no need to re-run on
    // scroll/overflow state changes, and doing so caused an infinite setState loop
    // because selectTab scrolls the container, which flips hasTabOverflow/canScrollLeft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeShellId, hasActiveTab, selectTab]);

  const closeTab = useCallback(
    async (shellId: string): Promise<void> => {
      const session = sessions.find((s) => s.shellId === shellId);
      if (!session) return;
      try {
        const sessionProcess = session.shellId === activeShellId ? contextAgenticProcess : undefined;
        if (sessionProcess) {
          await sessionProcess.close();
        } else if (session.shell) {
          await session.shell.close();
        }
        onTabClose?.(shellId);
      } catch (error) {
        console.error('[TabbedTerminal] Failed to close tab:', shellId, error);
      }
    },
    [sessions, activeShellId, contextAgenticProcess, onTabClose],
  );

  const handleCloseTab = useCallback(
    (shellId: string) => {
      void closeTab(shellId);
    },
    [closeTab],
  );

  const handleCloseAll = useCallback(() => {
    void Promise.all(visibleSessions.map((s) => closeTab(s.shellId)));
  }, [visibleSessions, closeTab]);

  const handleCloseAllButThis = useCallback(
    (shellId: string) => {
      void Promise.all(visibleSessions.filter((s) => s.shellId !== shellId).map((s) => closeTab(s.shellId)));
    },
    [visibleSessions, closeTab],
  );

  const handleCloseToTheRight = useCallback(
    (shellId: string) => {
      const idx = visibleSessions.findIndex((s) => s.shellId === shellId);
      const toClose = visibleSessions.slice(idx + 1);
      void Promise.all(toClose.map((s) => closeTab(s.shellId)));
    },
    [visibleSessions, closeTab],
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

    // Inject /rename only when user-initiated AND the worker is ready for input,
    // never when the title came from xterm (PTY escape sequence), to avoid a loop
    // where Claude sets the title → we inject /rename → Claude sets the title again.
    if (injectRename && session.shellId === activeShellId && contextAgenticProcess && isReadyForInput(contextAgenticProcess)) {
      void shell.sendInput(`/rename ${newName}\r`);
    }
  };

  // Get display name for a session
  const getDisplayName = (session: { shellId: string; name: string | null }): string => {
    return typeof session.name === 'string' && session.name ? session.name : session.shellId;
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
  const osPlatform: string =
    (navigator as Navigator & { userAgentData?: { platform: string } }).userAgentData?.platform ?? navigator.userAgent;
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
  const sandboxAvailable = !!dataContext.bootstrapInfo?.sandbox_available && !!dataContext.sandboxComputeNode;
  const dockerNodes = dataContext.dockerComputeNodes;
  const openers = useMemo<OpenerDescriptor[]>(() => {
    const list: OpenerDescriptor[] = [
      {
        id: 'claude',
        label: `Start Claude (${modLabel}+C)`,
        Icon: ClaudeIcon,
        iconClassName: 'text-orange-500',
        onActivate: handleStartClaude,
        available: true,
        pendingInline: isClaudeCreationPending,
        disabled: isTabCreationPending,
      },
      {
        id: 'claude-resume-by-id',
        label: 'Resume Claude session…',
        Icon: ClaudeResumeIcon,
        onActivate: () => setResumeByIdOpen(true),
        available: true,
        disabled: isTabCreationPending,
      },
      {
        id: 'terminal',
        label: `Open terminal (${modLabel}+T)`,
        Icon: SquareTerminal,
        onActivate: handleStartTerminal,
        available: true,
        pendingInline: isTerminalCreationPending,
        disabled: isTabCreationPending,
      },
      {
        id: 'sandbox',
        label: 'Open sandbox terminal (E2B)',
        Icon: Cloud,
        iconClassName: 'text-sky-500',
        onActivate: handleStartSandbox,
        available: sandboxAvailable,
        pendingInline: isTerminalCreationPending,
        disabled: isTabCreationPending,
      },
      {
        id: 'docker',
        label: 'Open docker terminal',
        Icon: Container,
        iconClassName: 'text-blue-500',
        onActivate: () => {
          if (dockerNodes.length === 1) handleStartDocker(dockerNodes[0]);
        },
        onDockerNodeSelect: handleStartDocker,
        available: dockerNodes.length > 0,
        pendingInline: isTerminalCreationPending,
        disabled: isTabCreationPending,
        dockerNodes,
      },
      {
        id: 'history',
        label: 'Open from history',
        Icon: History,
        onActivate: () => setHistoryModalOpen(true),
        available: true,
      },
    ];
    return list;
  }, [
    modLabel,
    handleStartClaude,
    handleStartTerminal,
    handleStartSandbox,
    handleStartDocker,
    sandboxAvailable,
    dockerNodes,
    isClaudeCreationPending,
    isTerminalCreationPending,
    isTabCreationPending,
  ]);

  const tabEndToolbar = addTabButton ? (
    <TerminalOpenerToolbar openers={openers} isTabCreationPending={isTabCreationPending} />
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
              // Sandbox flag: derived from the shell's compute node uname.
              // Used to swap the tab's green dot for a Cloud icon so sandbox
              // shells are visually distinct from local ones.
              const isSandboxShell = session.shell?.compute_node_uname === 'sandbox';
              // Use context process for the active tab (always authoritative);
              // inactive tabs have no reliable process reference.
              const sessionProcess = session.shellId === activeShellId ? contextAgenticProcess : undefined;

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
                  {/* Status indicator — Cloud icon for sandbox shells, green
                      dot for everything else. Sits to the left of the name. */}
                  {isSandboxShell ? (
                    <Cloud
                      className="h-3.5 w-3.5 shrink-0 text-sky-500"
                      data-testid={`shell-sandbox-icon-${session.shellId}`}
                      aria-label="Sandbox shell"
                    />
                  ) : (
                    <span
                      className={`inline-block h-2 w-2 shrink-0 rounded-full ${
                        isClosing ? 'bg-amber-500/70' : isDisabled ? 'bg-red-500/70' : 'bg-green-500/70'
                      }`}
                      data-testid={`shell-status-dot-${session.shellId}`}
                    />
                  )}
                  {Boolean(sessionProcess?.cliOptions?.worktree) && (
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
                        <ContextMenuTrigger asChild>{tabContent}</ContextMenuTrigger>
                      </TooltipTrigger>
                      {sessionProcess ? (
                        <TooltipContent
                          side="bottom"
                          className="border bg-popover p-2.5 text-popover-foreground shadow-md"
                        >
                          <ProcessInfoTooltip
                            process={sessionProcess}
                            statusReason={isDisabled ? session.statusReason : undefined}
                          />
                        </TooltipContent>
                      ) : isDisabled ? (
                        <TooltipContent side="bottom">{session.statusReason}</TooltipContent>
                      ) : null}
                    </Tooltip>
                  </TooltipProvider>
                  <ContextMenuContent>
                    <ContextMenuItem onSelect={() => handleTabDoubleClick(session.shellId, displayName)}>
                      Rename
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem onSelect={() => void handleStartClaude()}>
                      New Claude Session{' '}
                      <span className="ml-auto pl-4 text-xs text-muted-foreground">{modLabel}+C</span>
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

          </div>

          {/* Always render the toolbar outside the scroll container to prevent
              an oscillation loop: placing it inside increases scrollWidth,
              which triggers hasTabOverflow=true, moving it out, shrinking
              scrollWidth, flipping hasTabOverflow=false, and repeating. */}
          {tabEndToolbar}

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
                  onClick={handleStartTerminal}
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
                    />
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
      <HistoryModal
        open={historyModalOpen}
        onOpenChange={setHistoryModalOpen}
        onSelect={(item) => {
          setHistoryModalOpen(false);
          navigation.openDockPointer(item.dockPointer);
        }}
      />
      <InputDialog
        open={resumeByIdOpen}
        onOpenChange={setResumeByIdOpen}
        title="Resume Claude session"
        description="Paste a Claude CLI session id (UUID) to resume it in a new tab."
        placeholder="e.g. 0fa1a8c2-7b1d-4d6c-9d4e-b3e6c2f1d8aa"
        confirmLabel="Resume"
        onConfirm={(sessionId) => resumeInTerminal(sessionId)}
      />
    </div>
  );
};

export default TabbedTerminal;
