import {
  AgenticProcess,
  dataContext,
  getDisplayStatus,
  isProcessRunning,
  isReadyForInput,
  ProcessStatus,
  Shell,
  TypeId,
  ViewType,
  type ComputeNode,
} from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import { ClaudeIcon } from '@src/components/icons/ClaudeIcon';
import { CodexIcon } from '@src/components/icons/CodexIcon';
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
import { notify } from '@src/notifications';
import {
  acknowledgePending,
  formatTimeAgo,
  useLastStatusChange,
  usePendingSessionIds,
} from '@src/store/pending-actions-store';
import {
  closeTerminalTargets,
  terminalProcessId,
  terminalTargetKey,
  terminalTransportShellId,
  useProjectTerminals,
} from '@src/hooks/useActiveTerminals';
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
} from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { allowRename } from './rename-rules';
import { HistoryModal } from './HistoryModal';
import InteractiveTerminal from './interactive-terminal';
import { ProjectsCounterChip } from './ProjectsCounterChip';
import { TerminalOpenerToolbar } from './openers/TerminalOpenerToolbar';
import type { OpenerDescriptor } from './openers/tab_opener_types';

const ClaudeResumeIcon: React.FC<{ className?: string }> = ({ className }) => (
  <span className={`relative inline-flex items-center justify-center ${className ?? ''}`}>
    <ClaudeIcon className="!h-4 !w-4 text-orange-500" />
    <History className="absolute -bottom-0.5 -right-0.5 !h-2.5 !w-2.5 text-foreground/80" strokeWidth={3} />
  </span>
);

import type { TerminalTab } from '@src/hooks/useActiveTerminals';
import { resolveActive } from '@src/tabs/tab-model';
import { buildTabCandidates } from '@src/tabs/tab-candidates';
import { consumePendingIntent, peekPendingIntent } from '@src/tabs/pending-intent';

function isCodexProcess(process?: AgenticProcess | null): boolean {
  return process?.worker_type?.trim().toLowerCase() === 'codex';
}

function shouldAutoSavePtyTitle(session: TerminalTab, process?: AgenticProcess | null): boolean {
  const resolvedProcess = process ?? session.agenticProcess ?? null;
  if (!resolvedProcess) return session.targetTypeId.type === Shell.type;
  return !isCodexProcess(resolvedProcess);
}

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
  const lastStatusChangedAt = useLastStatusChange(process.id ?? null);

  return (
    <div className="min-w-[220px] space-y-1.5">
      {statusReason && <p className="text-[11px] text-amber-500">{statusReason}</p>}
      <div className="flex items-center gap-2">
        <span
          className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${isAlive ? 'bg-emerald-500' : 'bg-muted-foreground'}`}
        />
        <span className="text-[11px] font-semibold capitalize text-foreground">{status}</span>
        {lastStatusChangedAt !== null && (
          <span className="text-[10px] text-muted-foreground" data-testid="tab-status-ago">
            {formatTimeAgo(lastStatusChangedAt)}
          </span>
        )}
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
 * Active tab is set by the loader (dataContext.activeTerminalTargetTypeId).
 * Tab clicks navigate via navigation.openDock(entity.dockPointer), which re-runs the loader.
 * All flags and statuses come from Shell / AgenticProcess entities via useActiveTerminals.
 */
const TabbedTerminal: React.FC<TabbedTerminalProps> = ({
  className = '',
  addTabButton,
  collaborationRoomId,
  spawnProjectId,
  onTabClick,
  onTabClose,
  onTabOpen,
}) => {
  const { flow } = useAgentContext();
  const {
    activeShellId: contextShellId,
    activeTerminalTargetTypeId: contextActiveTerminalTargetTypeId,
    agenticProcess: contextAgenticProcess,
    project: contextProject,
  } = useContext();
  // Project-scoped strip: ``useProjectTerminals`` derives a filtered view of
  // the global terminalState by ``projectId``. ``spawnProjectId`` overrides for
  // CollaborationSpace strips that pin to a different project; otherwise the
  // hook defaults to ``dataContext.project?.id``.
  const tabsProjectId = spawnProjectId ?? contextProject?.id ?? null;
  const { data: projectTabs, pushTerminal, updateTerminal, refresh: refreshTabs } = useProjectTerminals(spawnProjectId);
  const sessions = useMemo(() => {
    if (collaborationRoomId == null) return projectTabs;
    return projectTabs.filter((t) => t.shell?.collaboration_room_id === collaborationRoomId);
  }, [projectTabs, collaborationRoomId]);
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
  const [editingTargetKey, setEditingTargetKey] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);
  const shouldSelectRenameInputRef = useRef(false);
  const [pendingTabCreation, setPendingTabCreation] = useState<{
    kind: 'claude' | 'codex' | 'terminal';
    targetKey: string | null;
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

  const { navigation, currentDock } = useDockNavigation();
  const visibleSessions = sessions;

  // Active tab is URL-derived. The URL is the single source of truth:
  // click → navigate(url) → loader → context → render. We parse currentDock
  // (set by react-router from the live URL params), NOT dataContext fields
  // that were set optimistically on the click path — those would re-introduce
  // the "tab highlights before URL changes" inversion called out in CLAUDE.md.
  const urlActiveTargetTypeId = useMemo<TypeId | null>(() => {
    if (currentDock?.viewType !== ViewType.SHELL) return null;
    const pointer = currentDock.pointer;
    if (!pointer) return null;
    if (DockPointer.isAgenticProcessPointer(pointer)) {
      return new TypeId(AgenticProcess.type, DockPointer.extractAgenticProcessId(pointer));
    }
    const shellId = pointer.startsWith(Shell.type + '-') ? pointer.slice(Shell.type.length + 1) : pointer;
    return new TypeId(Shell.type, shellId);
  }, [currentDock?.viewType, currentDock?.pointer]);

  // Fallback for views that don't drive the strip via /dock/shell (overview
  // panes, embedded strips). Context fields here are written by the loader,
  // not by click handlers — still URL-derived, just one indirection away.
  const fallbackActiveTargetTypeId =
    contextAgenticProcess?.typeId ??
    (contextShellId ? new TypeId(Shell.type, contextShellId) : null) ??
    visibleSessions[0]?.targetTypeId ??
    null;
  const activeTargetTypeId = urlActiveTargetTypeId ?? contextActiveTerminalTargetTypeId ?? fallbackActiveTargetTypeId;
  const activeTargetKey = activeTargetTypeId?.toString() ?? '';
  const hasActiveTab = Boolean(
    activeTargetKey && visibleSessions.some((session) => terminalTargetKey(session) === activeTargetKey),
  );

  // Lazy-mount: only mount the active terminal initially; mount others on
  // first switch. With many tabs (e.g. 69), eagerly mounting all of them
  // caused a 14-second main-thread freeze from 69 InteractiveTerminal
  // component trees (each with ~30 hooks, xterm init, addon loading).
  // The Set never shrinks so subsequent switches stay instant.
  const [mountedTargetKeys, setMountedTargetKeys] = useState<Set<string>>(
    () => new Set(activeTargetKey ? [activeTargetKey] : []),
  );
  useEffect(() => {
    if (!activeTargetKey) return;
    setMountedTargetKeys((prev) => {
      if (prev.has(activeTargetKey)) return prev;
      const next = new Set(prev);
      next.add(activeTargetKey);
      return next;
    });
  }, [activeTargetKey]);

  // Keep dataContext in sync for other consumers
  useEffect(() => {
    if (activeTargetTypeId) dataContext.setActiveTerminalTargetTypeId(activeTargetTypeId);
  }, [activeTargetTypeId]);

  // Self-heal when the active shell falls out of the visible strip — happens
  // after a project context switch (chip popover, footer modal, deep link).
  // We pick the first tab in the new strip and navigate to it; the route
  // loader updates URL + activeTerminalTargetTypeId + dataContext.project together so
  // the strip, panel, and URL stay coherent regardless of who triggered the
  // context change.
  useEffect(() => {
    if (visibleSessions.length === 0) return;
    if (hasActiveTab) return;
    // URL-first self-heal via the single resolver: prefer an explicit pending
    // intent (footer-chip click → Bug 2), else the most-recently-active tab
    // (project round-trip → Bug 1), else lowest tab_order. We only RESOLVE a key
    // and navigate; the route loader writes context. Replaces the old
    // unconditional `visibleSessions[0]` snap.
    const { activeKey, consumedPendingIntent } = resolveActive({
      candidates: buildTabCandidates(visibleSessions),
      urlActiveKey: null, // self-heal only runs when no active tab is in the strip
      pendingIntentKey: peekPendingIntent(),
    });
    if (consumedPendingIntent) consumePendingIntent();
    const target = visibleSessions.find((s) => terminalTargetKey(s) === activeKey);
    if (!target) return;
    // Land on the live terminal, not the transcript: AgenticProcess's default
    // ``dockPointer`` is read-only (lens/transcript); the terminal pane wants
    // ``terminalDockPointer`` so the PTY route resolves and surfaces.
    const pointer = target.agenticProcess?.terminalDockPointer ?? target.shell?.dockPointer;
    if (pointer) navigation.openDockPointer(pointer);
  }, [hasActiveTab, visibleSessions, navigation]);

  const clearPendingTabCreation = useCallback(() => {
    tabCreationLockRef.current = false;
    setPendingTabCreation(null);
  }, []);

  // "Start Claude" button — creates AgenticProcess entity, then emits onTabOpen
  // so the consumer can navigate / tag / start.
  const startAgenticTab = useCallback(
    async (kind: 'claude' | 'codex', workerType?: 'claude_code' | 'codex') => {
      if (tabCreationLockRef.current) return;
      tabCreationLockRef.current = true;
      setPendingTabCreation({ kind, targetKey: null, targetShellId: null, targetProcessId: null });
      const result = await navigation.openNewClaudeProcess({
        ...(spawnProjectId ? { projectId: spawnProjectId } : {}),
        ...(workerType ? { workerType } : {}),
      });
      if (!result) {
        clearPendingTabCreation();
        return;
      }
      setPendingTabCreation({
        kind,
        targetKey: new TypeId(AgenticProcess.type, result.processId).toString(),
        targetShellId: result.shellId,
        targetProcessId: result.processId,
      });
      // The just-created entities may not yet be in the dataManager cache
      // (the createProcess() round-trip resolves before the cache populates
      // them under the typeId). Fetch them so the new tab carries the
      // ``AgenticProcess`` instance — without it the navigation useEffect
      // falls back to ``shell.dockPointer`` and the URL lands on
      // ``/dock/shell/shell-<uuid>`` instead of the agentic_process route.
      const agenticProcess =
        AgenticProcess.getByIdFromCache<AgenticProcess>(result.processId) ??
        (await AgenticProcess.getById(result.processId)) ??
        undefined;
      const shell = result.shellId
        ? (Shell.getByIdFromCache<Shell>(result.shellId) ?? (await Shell.getById(result.shellId)) ?? undefined)
        : undefined;
      // Atomic create: backend spawned the Shell + PTY before responding,
      // so result.shellId is always populated. Push directly into terminalState.
      const newTab: TerminalTab = {
        targetTypeId: new TypeId(AgenticProcess.type, result.processId),
        shellId: result.shellId ?? '',
        processId: result.processId,
        tabOrder: shell?.tab_order ?? 0,
        name: shell?.name ?? null,
        type: 'claude',
        agenticProcess,
        shell,
        isDisabled: false,
        statusReason: '',
        projectId: agenticProcess?.project_id ?? shell?.project_id ?? null,
        projectDisplayName: null,
      };
      pushTerminal(newTab);
      onTabOpen?.(newTab);
    },
    [clearPendingTabCreation, navigation, onTabOpen, pushTerminal, spawnProjectId],
  );

  const handleStartClaude = useCallback(() => startAgenticTab('claude', 'claude_code'), [startAgenticTab]);
  const handleStartCodex = useCallback(() => startAgenticTab('codex', 'codex'), [startAgenticTab]);

  const startTerminalTab = useCallback(
    async (computeNode?: ComputeNode) => {
      if (tabCreationLockRef.current) return;
      tabCreationLockRef.current = true;
      setPendingTabCreation({ kind: 'terminal', targetKey: null, targetShellId: null, targetProcessId: null });
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
      setPendingTabCreation({
        kind: 'terminal',
        targetKey: new TypeId(Shell.type, result.shellId).toString(),
        targetShellId: result.shellId,
        targetProcessId: null,
      });
      const shell = Shell.getByIdFromCache<Shell>(result.shellId) ?? undefined;
      const newTab: TerminalTab = {
        targetTypeId: new TypeId(Shell.type, result.shellId),
        shellId: result.shellId,
        processId: null,
        tabOrder: shell?.tab_order ?? 0,
        name: shell?.name ?? null,
        type: 'plain',
        shell,
        isDisabled: false,
        statusReason: '',
        projectId: shell?.project_id ?? null,
        projectDisplayName: null,
      };
      pushTerminal(newTab);
      onTabOpen?.(newTab);
    },
    [clearPendingTabCreation, navigation, onTabOpen, pushTerminal, spawnProjectId],
  );

  const handleStartTerminal = useCallback(() => startTerminalTab(), [startTerminalTab]);

  const handleStartSandbox = useCallback(() => {
    const sandboxNode = dataContext.sandboxComputeNode;
    if (!sandboxNode) return;
    return startTerminalTab(sandboxNode);
  }, [startTerminalTab]);

  const handleStartDocker = useCallback((dockerNode: ComputeNode) => startTerminalTab(dockerNode), [startTerminalTab]);

  // URL-first: click handler only emits onTabClick. The consumer turns that
  // into navigation.openDock(pointer); the loader then writes context; the
  // strip re-renders because activeTargetTypeId is URL-derived. No optimistic
  // dataContext writes here — see CLAUDE.md "URL-first navigation".
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const navigateToSession = useCallback(
    (targetKey: string) => {
      const session = sessionsRef.current.find((s) => terminalTargetKey(s) === targetKey);
      if (!session) return;
      if (import.meta.env.DEV) {
        (window as Record<string, unknown>).__shellNavT0 = performance.now();
        console.log(`[PERF] +0ms tab click → ${targetKey}`);
      }
      onTabClick?.(targetKey, session);
    },
    [onTabClick],
  );

  const scrollSelectedTabIntoView = useCallback((targetKey: string, behavior: ScrollBehavior = 'smooth') => {
    const container = tabContainerRef.current;
    const tab = tabRefs.current[targetKey];
    if (!container || !tab) return;

    const tabLeft = tab.offsetLeft;
    const tabRight = tabLeft + tab.offsetWidth;
    const visibleLeft = container.scrollLeft;
    const visibleRight = visibleLeft + container.clientWidth;

    if (tabLeft < visibleLeft) {
      container.scrollTo({ left: tabLeft, behavior });
      return;
    }

    if (tabRight > visibleRight) {
      container.scrollTo({ left: tabRight - container.clientWidth, behavior });
    }
  }, []);

  const selectTab = useCallback(
    (targetKey: string, options?: { navigate?: boolean; behavior?: ScrollBehavior }) => {
      if (!targetKey) return;

      if (options?.navigate !== false) {
        navigateToSession(targetKey);
      }

      const behavior = options?.behavior ?? 'smooth';
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          scrollSelectedTabIntoView(targetKey, behavior);
        });
      });
    },
    [navigateToSession, scrollSelectedTabIntoView],
  );

  useEffect(() => {
    if (!pendingTabCreation) return;
    const session = visibleSessions.find((s) => {
      if (pendingTabCreation.targetKey && terminalTargetKey(s) === pendingTabCreation.targetKey) return true;
      if (pendingTabCreation.targetShellId && s.shellId === pendingTabCreation.targetShellId) return true;
      if (pendingTabCreation.targetProcessId && s.agenticProcess?.id === pendingTabCreation.targetProcessId)
        return true;
      return false;
    });
    if (session) {
      const key = terminalTargetKey(session);
      // Don't write dataContext here — the consumer's onTabOpen already called
      // navigation.openDock(pointer) and the loader owns the context writes.
      clearPendingTabCreation();
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          scrollSelectedTabIntoView(key);
        });
      });
    }
  }, [visibleSessions, pendingTabCreation, clearPendingTabCreation, scrollSelectedTabIntoView]);

  // Mount + late-arriving-sessions + layout-shift: on initial mount the active
  // tab may be in-view because only some sessions have rendered (so the
  // strip is short). When the rest of the sessions land, the active tab gets
  // pushed off-screen. When we then scroll right, `canScrollLeft` flips true
  // and a left-arrow button mounts to our LEFT, shrinking our clientWidth and
  // clipping the active tab on the right. ResizeObserver fires on either
  // layout shift, so we re-evaluate scroll-into-view until the tab is
  // genuinely visible — the function is a no-op once the tab fits.
  // hasTabOverflow/canScrollLeft are intentionally NOT in the useEffect deps
  // (they flip from the scroll itself → would infinite-loop).
  const lastScrolledKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeTargetKey || !hasActiveTab) return;
    const isFirstScrollForKey = lastScrolledKeyRef.current !== activeTargetKey;
    lastScrolledKeyRef.current = activeTargetKey;
    selectTab(activeTargetKey, { navigate: false, behavior: isFirstScrollForKey ? 'auto' : 'smooth' });
  }, [activeTargetKey, hasActiveTab, selectTab, visibleSessions.length]);

  useEffect(() => {
    const container = tabContainerRef.current;
    if (!container || !activeTargetKey || !hasActiveTab) return;
    const observer = new ResizeObserver(() => {
      scrollSelectedTabIntoView(activeTargetKey, 'auto');
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [activeTargetKey, hasActiveTab, scrollSelectedTabIntoView]);

  const closeTabs = useCallback(
    async (tabs: TerminalTab[]): Promise<void> => {
      const keys = tabs.map(terminalTargetKey);
      const result = await closeTerminalTargets(keys);
      if (result.invalid.length > 0 || result.missing.length > 0) {
        console.warn('[TabbedTerminal] Some terminal close targets were not accepted:', result);
      }
      if (result.accepted.length > 0) onTabClose?.(result.accepted);
    },
    [onTabClose],
  );

  const handleCloseTab = useCallback(
    (targetKey: string) => {
      const session = visibleSessions.find((s) => terminalTargetKey(s) === targetKey);
      if (session) void closeTabs([session]);
    },
    [visibleSessions, closeTabs],
  );

  const handleCloseAll = useCallback(() => {
    void closeTabs(visibleSessions);
  }, [visibleSessions, closeTabs]);

  const handleCloseAllButThis = useCallback(
    (targetKey: string) => {
      void closeTabs(visibleSessions.filter((s) => terminalTargetKey(s) !== targetKey));
    },
    [visibleSessions, closeTabs],
  );

  const handleCloseToTheRight = useCallback(
    (targetKey: string) => {
      const idx = visibleSessions.findIndex((s) => terminalTargetKey(s) === targetKey);
      const toClose = visibleSessions.slice(idx + 1);
      void closeTabs(toClose);
    },
    [visibleSessions, closeTabs],
  );

  const handleTabDoubleClick = (targetKey: string, currentName: string) => {
    shouldSelectRenameInputRef.current = true;
    setEditingTargetKey(targetKey);
    setEditingName(currentName);
  };

  useEffect(() => {
    if (!editingTargetKey || !shouldSelectRenameInputRef.current) return;
    const input = renameInputRef.current;
    if (!input) return;
    input.focus();
    input.setSelectionRange(0, input.value.length);
  });

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    shouldSelectRenameInputRef.current = false;
    setEditingName(e.target.value);
  };

  const handleNameBlur = () => {
    shouldSelectRenameInputRef.current = false;
    if (editingTargetKey && editingName.trim()) {
      const session = visibleSessions.find((s) => terminalTargetKey(s) === editingTargetKey);
      if (session?.shell) onTabRename(session, editingName.trim());
    }
    setEditingTargetKey(null);
  };

  const handleNameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      handleNameBlur();
    } else if (e.key === 'Escape') {
      shouldSelectRenameInputRef.current = false;
      setEditingTargetKey(null);
    } else {
      shouldSelectRenameInputRef.current = false;
    }
  };

  const onTabRename = (
    session: (typeof visibleSessions)[number],
    newName: string,
    fromPty = false,
    processOverride?: AgenticProcess | null,
  ): void => {
    // Source of truth: AgenticProcess for process-backed tabs, Shell for pure shells.
    // Whichever owns the tab owns its name + auto_rename. No cross-entity propagation.
    const source = session.agenticProcess ?? session.shell;
    if (!source) return;
    if (!allowRename(newName)) return;
    if (fromPty && !shouldAutoSavePtyTitle(session, processOverride)) return;
    if (fromPty && !source.auto_rename) return; // user already pinned this tab
    if (source.name === newName) return; // no-op — no flip, no save, no /rename

    const previousName = session.name;
    updateTerminal(session, { name: newName }); // optimistic; reconciles via WS data_op

    source.name = newName;
    if (!fromPty) source.auto_rename = false;
    void source.save().catch((error) => {
      updateTerminal(session, { name: previousName });
      console.error('[TabbedTerminal] Failed to rename tab:', terminalTargetKey(session), error);
    });

    // User-initiated rename → tell Claude its own session title so it stops emitting
    // the old one on the next OSC update. Frontend-only; never on PTY-sourced renames.
    if (
      !fromPty &&
      session.shell &&
      terminalTargetKey(session) === activeTargetKey &&
      contextAgenticProcess &&
      isReadyForInput(contextAgenticProcess)
    ) {
      void session.shell.sendInput(`/rename ${newName}\r`);
    }
  };

  // Get display name for a session
  const getDisplayName = (session: TerminalTab): string => {
    return typeof session.name === 'string' && session.name ? session.name : terminalTargetKey(session);
  };

  // Check if tabs overflow and update scroll button state
  const updateScrollState = () => {
    const container = tabContainerRef.current;
    if (!container) return;

    const { scrollLeft, scrollWidth, clientWidth } = container;
    const hasOverflow = scrollWidth > clientWidth + 1;
    setHasTabOverflow(hasOverflow);
    // 1px epsilon matches the right-side check: sub-pixel scrollLeft values
    // (macOS trackpad inertia, fractional zoom) would otherwise keep the
    // left chevron lit when visually at the start.
    setCanScrollLeft(hasOverflow && scrollLeft > 1);
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
        void handleCloseTab(activeTargetKey);
      } else if (e.key === 't' || e.key === 'T') {
        e.preventDefault();
        void handleStartClaude();
      } else if (e.key === 'PageUp') {
        e.preventDefault();
        const idx = visibleSessions.findIndex((s) => terminalTargetKey(s) === activeTargetKey);
        if (idx > 0) selectTab(terminalTargetKey(visibleSessions[idx - 1]));
      } else if (e.key === 'PageDown') {
        e.preventDefault();
        const idx = visibleSessions.findIndex((s) => terminalTargetKey(s) === activeTargetKey);
        if (idx < visibleSessions.length - 1) selectTab(terminalTargetKey(visibleSessions[idx + 1]));
      }
    };
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [activeTargetKey, handleStartTerminal, handleStartClaude, visibleSessions, selectTab, handleCloseTab, modKey]);

  const isTabCreationPending = pendingTabCreation !== null;
  const isClaudeCreationPending = pendingTabCreation?.kind === 'claude';
  const isCodexCreationPending = pendingTabCreation?.kind === 'codex';
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
        onActivate: () => {
          void handleStartClaude();
        },
        available: true,
        pendingInline: isClaudeCreationPending,
        disabled: isTabCreationPending,
      },
      {
        id: 'codex',
        label: 'Start Codex',
        Icon: CodexIcon,
        iconClassName: 'text-emerald-500',
        onActivate: () => {
          void handleStartCodex();
        },
        available: true,
        pendingInline: isCodexCreationPending,
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
        onActivate: () => {
          void handleStartTerminal();
        },
        available: true,
        pendingInline: isTerminalCreationPending,
        disabled: isTabCreationPending,
      },
      {
        id: 'sandbox',
        label: 'Open sandbox terminal (E2B)',
        Icon: Cloud,
        iconClassName: 'text-sky-500',
        onActivate: () => {
          void handleStartSandbox();
        },
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
          if (dockerNodes.length === 1) void handleStartDocker(dockerNodes[0]);
        },
        onDockerNodeSelect: (dockerNode) => {
          void handleStartDocker(dockerNode);
        },
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
    handleStartCodex,
    handleStartTerminal,
    handleStartSandbox,
    handleStartDocker,
    sandboxAvailable,
    dockerNodes,
    isClaudeCreationPending,
    isCodexCreationPending,
    isTerminalCreationPending,
    isTabCreationPending,
  ]);

  const tabEndToolbar = addTabButton ? (
    <TerminalOpenerToolbar openers={openers} isTabCreationPending={isTabCreationPending} />
  ) : null;

  // PendingAction set: process ids that recently became ready-for-input.
  // Global scope here — the strip's own filtering already pins which tabs render,
  // so non-rendered ids in this set are inert.
  const pendingProcessIds = usePendingSessionIds();

  // Auto-acknowledge whenever the active tab itself is pending. Covers two
  // cases the click-handler ack misses: (a) ready transition arrives via WS
  // while the user is already sitting on the tab; (b) the active tab is
  // selected from the URL on load/refresh (no click). Without this, the user
  // sees a glow on the very tab they're reading.
  const activeSession = useMemo(
    () => visibleSessions.find((s) => terminalTargetKey(s) === activeTargetKey),
    [visibleSessions, activeTargetKey],
  );
  const activePendingProcessId = activeSession ? terminalProcessId(activeSession) : null;
  const activeIsPending = activePendingProcessId ? pendingProcessIds.has(activePendingProcessId) : false;
  useEffect(() => {
    if (activeIsPending && activePendingProcessId) {
      acknowledgePending(activePendingProcessId);
    }
  }, [activeIsPending, activePendingProcessId]);

  return (
    <div className={`flex h-full ${className}`}>
      {/* Main terminal area */}
      <div className="flex h-full w-full flex-col">
        {/* Tab Bar */}
        <div className="flex items-center border-b bg-muted" data-testid="terminal-tab-bar">
          <ProjectsCounterChip currentProjectId={tabsProjectId} />
          {/* Left Scroll Button — always reserves layout space when tabs
              overflow, so toggling `canScrollLeft` doesn't shift the
              tab row horizontally. Mirrors the right-button pattern. */}
          {hasTabOverflow && (
            <Button
              variant="ghost"
              size="icon"
              className={`h-7 w-7 shrink-0 rounded-none ${canScrollLeft ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
              onClick={() => scrollTabs('left')}
              aria-label="Scroll tabs left"
              tabIndex={canScrollLeft ? 0 : -1}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
          )}

          {/* Scrollable Tab Container */}
          <div
            ref={tabContainerRef}
            data-testid="terminal-tabs-scroll-container"
            className="scrollbar-hide flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-1 pl-2 pr-0"
            style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
          >
            {visibleSessions.map((session, index) => {
              const targetKey = terminalTargetKey(session);
              const sessionProcess =
                terminalProcessId(session) && contextAgenticProcess?.id === terminalProcessId(session)
                  ? contextAgenticProcess
                  : session.agenticProcess;
              const displayName = getDisplayName(session);
              const isDisabled = session.isDisabled;
              const workerType = sessionProcess?.worker_type?.toLowerCase() ?? '';
              const providerKind =
                session.targetTypeId.type === Shell.type ? 'shell' : workerType === 'codex' ? 'codex' : 'claude';
              const ProviderIcon =
                providerKind === 'codex' ? CodexIcon : providerKind === 'claude' ? ClaudeIcon : SquareTerminal;
              const providerIconClassName =
                providerKind === 'codex'
                  ? 'text-emerald-500'
                  : providerKind === 'claude'
                    ? 'text-orange-500'
                    : 'text-muted-foreground';
              const providerLabel =
                providerKind === 'codex' ? 'Codex tab' : providerKind === 'claude' ? 'Claude Code tab' : 'Shell tab';
              const tabTestId =
                session.targetTypeId.type === Shell.type
                  ? `tab-shell-${session.targetTypeId.id}`
                  : `tab-shell-${targetKey}`;
              const indicatorKey = session.targetTypeId.type === Shell.type ? session.targetTypeId.id : targetKey;
              const sessionProcessId = terminalProcessId(session);
              const isActive = activeTargetKey === targetKey;
              // Active tab never glows: the user is already looking at it,
              // so highlighting it as "needs attention" is wrong. The
              // useEffect above also acks it, but suppressing the class
              // here avoids a one-frame flash on the render before the
              // effect commits.
              const isPending = sessionProcessId && !isActive ? pendingProcessIds.has(sessionProcessId) : false;

              const tabContent = (
                <div
                  ref={(node) => {
                    tabRefs.current[targetKey] = node;
                  }}
                  className={`group flex shrink-0 select-none items-center gap-2 rounded-t border-b-2 px-3 py-1.5 transition-colors ${
                    isDisabled
                      ? 'cursor-not-allowed border-transparent bg-muted/30 text-muted-foreground/50'
                      : activeTargetKey === targetKey
                        ? 'cursor-pointer border-primary bg-background text-foreground'
                        : 'cursor-pointer border-transparent bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground'
                  } ${isPending ? 'animate-pending-glow rounded-md' : ''}`}
                  onClick={() => {
                    if (isDisabled) return;
                    selectTab(targetKey);
                    acknowledgePending(sessionProcessId);
                  }}
                  data-testid={tabTestId}
                  data-terminal-target={targetKey}
                >
                  <ProviderIcon
                    className={`h-3.5 w-3.5 shrink-0 ${providerIconClassName}`}
                    data-testid={`tab-provider-icon-${indicatorKey}`}
                    data-provider={providerKind}
                    aria-label={providerLabel}
                  />
                  {Boolean(sessionProcess?.cliOptions?.worktree) && (
                    <FolderGit2 className="h-3 w-3 shrink-0 text-amber-500" />
                  )}
                  {editingTargetKey === targetKey ? (
                    <input
                      ref={renameInputRef}
                      type="text"
                      value={editingName}
                      onChange={handleNameChange}
                      onBlur={handleNameBlur}
                      onKeyDown={handleNameKeyDown}
                      className="min-w-[80px] rounded border border-border bg-background px-1 py-0 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                      autoFocus
                      onFocus={(e) => {
                        if (shouldSelectRenameInputRef.current) {
                          e.currentTarget.setSelectionRange(0, e.currentTarget.value.length);
                        }
                      }}
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <span
                      className="text-sm font-medium"
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        handleTabDoubleClick(targetKey, displayName);
                      }}
                    >
                      {displayName}
                    </span>
                  )}

                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleCloseTab(targetKey);
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
                <ContextMenu key={targetKey}>
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
                    <ContextMenuItem onSelect={() => handleTabDoubleClick(targetKey, displayName)}>
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
                    <ContextMenuItem onSelect={() => handleCloseTab(targetKey)}>
                      Close <span className="ml-auto pl-4 text-xs text-muted-foreground">{modLabel}+W</span>
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={handleCloseAll}>Close All</ContextMenuItem>
                    <ContextMenuItem
                      onSelect={() => handleCloseAllButThis(targetKey)}
                      disabled={visibleSessions.length <= 1}
                    >
                      Close All But This
                    </ContextMenuItem>
                    <ContextMenuItem
                      onSelect={() => handleCloseToTheRight(targetKey)}
                      disabled={index >= visibleSessions.length - 1}
                    >
                      Close to the Right
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              );
            })}

            {/* Toolbar flows after the last tab but sticks to the right edge
                when tabs overflow. Placement is unconditional, so it does not
                oscillate with hasTabOverflow. */}
            {tabEndToolbar && (
              <div className="sticky right-0 z-10 flex items-center self-stretch bg-muted">{tabEndToolbar}</div>
            )}
          </div>

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

          {/* Close All button — shown when 2+ tabs are open. Tab count badge
              hints at the destructive scope before clicking. */}
          {visibleSessions.length >= 2 && (
            <TooltipProvider delayDuration={600}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mx-1.5 h-6 shrink-0 gap-1.5 rounded-md border-border bg-background px-2 text-foreground shadow-sm hover:border-destructive/60 hover:bg-destructive/10 hover:text-destructive"
                    onClick={handleCloseAll}
                    aria-label={`Close all ${visibleSessions.length} tabs`}
                    data-testid="close-all-tabs-button"
                  >
                    <X className="h-3.5 w-3.5" />
                    <span className="inline-flex h-4 min-w-[1.125rem] items-center justify-center rounded-full bg-foreground/10 px-1 text-[10px] font-semibold tabular-nums leading-none text-foreground">
                      {visibleSessions.length}
                    </span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Close all {visibleSessions.length} tabs</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>

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
                  {isMounted && transportShellId && (
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
        onSelect={(entry) => {
          void (async () => {
            setHistoryModalOpen(false);
            try {
              // Always route through openShellProcess so the row opens the
              // terminal view (process.terminalDockPointer), not whatever the
              // generic dockPointer would resolve to (e.g. transcript).
              let processId: string | null = entry.agentic_process_id;
              if (!processId) {
                const process = await AgenticProcess.getByWorkerId(entry.worker_id);
                processId = process?.id ?? null;
              }
              if (!processId) {
                notify.error({
                  title: 'Session not found',
                  message: `Session ${entry.worker_id} is not in Claude or Codex history.`,
                  id: `session-not-found:${entry.worker_id}`,
                });
                return;
              }
              await navigation.openShellProcess(processId);
            } catch (err) {
              console.error('[TabbedTerminal] Failed to open session from history:', err);
            } finally {
              void refreshTabs();
            }
          })();
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
