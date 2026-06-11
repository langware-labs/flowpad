/**
 * useTerminalStripController — the terminal strip-controller logic extracted
 * verbatim from TabbedTerminal (docs/tab-management.md Part 3 §6) so it can be
 * composed by both the embedded terminal view (TabbedTerminal) and the unified
 * content-panel strip. Owns:
 *
 *   - project-scoped data (useProjectTerminals + collaboration-room filter)
 *   - URL-first active-key derivation + self-heal via `resolveActive`
 *   - creation flows (claude/codex/copilot/terminal/sandbox/docker) +
 *     history/resume/install modal state
 *   - close / rename / popout handlers (terminal kind strategies, Part 3 §3)
 *   - strip item building (vendor icon overrides stay here — they are the
 *     terminal strategy's icon resolution, Part 3 §6)
 *   - keyboard shortcuts and pending-ack
 *
 * It is a mechanical extraction: behaviors and comments are preserved; the
 * host component only renders (TabStrip + panels + `modals`).
 */
import {
  AgenticProcess,
  capabilityManager,
  CapabilityKinds,
  dataContext,
  getDisplayStatus,
  HARNESS_CAPABILITY_KINDS,
  isProcessRunning,
  isReadyForInput,
  ProcessStatus,
  Shell,
  TypeId,
  ViewType,
  type ComputeNode,
} from '@sdk';
import { useCapability, type UseCapabilityResult } from '@sdk/react/hooks';
import { DockPointer } from '@src/navigation/DockPointer';
import { ClaudeIcon } from '@src/components/icons/ClaudeIcon';
import { CodexIcon } from '@src/components/icons/CodexIcon';
import { CopilotIcon } from '@src/components/icons/CopilotIcon';
import { useEnsureProject } from '@src/components/project-selector';
import { InputDialog } from '@src/components/ui/input-dialog';
import { type TabStripContextMenuItem, type TabStripItem } from '@src/components/tabs/TabStrip';
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
  terminalDockPointer,
  terminalProcessId,
  terminalTargetKey,
  useProjectTerminals,
  type TerminalTab,
} from '@src/tabs/useTabs';
import { useContext } from '@src/hooks/useContext';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { Cloud, Container, FolderGit2, History, SquareTerminal } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { allowRename, shouldAutoSavePtyTitle } from '@src/components/terminal/rename-rules';
import { HistoryModal } from '@src/components/terminal/HistoryModal';
import { ProjectsCounterChip, type ProjectWorkerType } from '@src/components/terminal/ProjectsCounterChip';
import { AskInstallOneOfDialog } from '@src/components/terminal/openers/AskInstallOneOfDialog';
import { TerminalOpenerToolbar } from '@src/components/terminal/openers/TerminalOpenerToolbar';
import type { OpenerDescriptor } from '@src/components/terminal/openers/tab_opener_types';
import { resolveActive } from '@src/tabs/tab-model';
import { buildTabCandidates } from '@src/tabs/tab-candidates';
import { consumePendingIntent, peekPendingIntent } from '@src/tabs/pending-intent';
import { waitForWinReady } from '@src/tabs/popout-handoff';

const ClaudeResumeIcon: React.FC<{ className?: string }> = ({ className }) => (
  <span className={`relative inline-flex items-center justify-center ${className ?? ''}`}>
    <ClaudeIcon className="!h-4 !w-4 text-orange-500" />
    <History className="absolute -bottom-0.5 -right-0.5 !h-2.5 !w-2.5 text-foreground/80" strokeWidth={3} />
  </span>
);

/** Vendor metadata per terminal provider kind — the single source for the
 *  strip chips' icon resolution (the terminal strategy's icon override,
 *  Part 3 §6) and the vendor openers' glyph/color. */
const PROVIDER_META: Record<
  'claude' | 'codex' | 'copilot' | 'shell',
  { Icon: React.ComponentType<{ className?: string }>; iconClassName: string; label: string }
> = {
  claude: { Icon: ClaudeIcon, iconClassName: 'text-orange-500', label: 'Claude Code tab' },
  codex: { Icon: CodexIcon, iconClassName: 'text-emerald-500', label: 'Codex tab' },
  copilot: { Icon: CopilotIcon, iconClassName: 'text-sky-500', label: 'Copilot tab' },
  shell: { Icon: SquareTerminal, iconClassName: 'text-muted-foreground', label: 'Shell tab' },
};

/** Display name for a session chip — entity name, falling back to the target key. */
function getDisplayName(session: TerminalTab): string {
  return typeof session.name === 'string' && session.name ? session.name : terminalTargetKey(session);
}

/** Opener warning for a harness: set when its backend capability check ran and failed. */
function harnessWarning(capability: UseCapabilityResult): string | null {
  if (!capability.checked || capability.available) return null;
  return capability.result?.message ?? 'This harness is not available on this machine.';
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

export interface TerminalStripControllerOptions {
  /** Whether to show the "Add Tab" opener toolbar (default: false) */
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
   * controller never calls navigation.openDock for tab clicks itself.
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
   * Register the window-level mod+W / mod+T / mod+PgUp/PgDn shortcuts
   * (default: true). A host that delegates its strip to another controller
   * instance (TabbedTerminal with `showStrip=false`) disables its own copy so
   * the shortcuts don't double-fire.
   */
  enableShortcuts?: boolean;
}

export interface TerminalStripController {
  /** Project + room scoped sessions (the rows the strip and panels render). */
  visibleSessions: TerminalTab[];
  /** URL-derived active key (Part 3 §6: active derives from currentDock). */
  activeTargetKey: string;
  /** Lazy-mount set — sessions that have been active at least once. */
  mountedTargetKeys: Set<string>;
  /** The loader-resolved active process (panels prefer it over cache rows). */
  contextAgenticProcess: AgenticProcess | null | undefined;
  /** The project the strip is scoped to. */
  tabsProjectId: string | null;
  /** Kind-agnostic chip descriptors for TabStrip. */
  stripItems: TabStripItem[];
  /** Chip click: URL-first navigation emit + pending-ack. */
  handleSelect: (targetKey: string) => void;
  handleCloseTab: (targetKey: string) => void;
  handleCloseMany: (keys: string[]) => void;
  handleRenameCommit: (targetKey: string, newName: string) => void;
  handleOpenExternalTab: (targetKey: string) => void;
  /** Rename strategy — also used by panels for PTY title auto-save. */
  onTabRename: (
    session: TerminalTab,
    newName: string,
    fromPty?: boolean,
    processOverride?: AgenticProcess | null,
  ) => void;
  newTabMenuItems: TabStripContextMenuItem[];
  closeShortcutLabel: string;
  /** Leading fixed node (ProjectsCounterChip). */
  leading: React.ReactNode;
  /** Trailing opener toolbar (null unless `addTabButton`). */
  trailing: React.ReactNode;
  /** History / resume / install dialogs — render once in the host. */
  modals: React.ReactNode;
  // Creation state for empty-state buttons.
  isTabCreationPending: boolean;
  isClaudeCreationPending: boolean;
  isTerminalCreationPending: boolean;
  handleStartClaude: () => Promise<void> | void;
  handleStartTerminal: () => Promise<void> | void;
}

export function useTerminalStripController({
  addTabButton,
  collaborationRoomId,
  spawnProjectId,
  onTabClick,
  onTabClose,
  onTabOpen,
  enableShortcuts = true,
}: TerminalStripControllerOptions = {}): TerminalStripController {
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
  const visibleSessions = useMemo(() => {
    if (collaborationRoomId == null) return projectTabs;
    return projectTabs.filter((t) => t.shell?.collaboration_room_id === collaborationRoomId);
  }, [projectTabs, collaborationRoomId]);
  const _perfLoggedRef = useRef(false);
  if (!_perfLoggedRef.current) {
    _perfLoggedRef.current = true;
    const t0 = (window as Record<string, unknown>).__shellNavT0 as number | undefined;
    if (t0 !== undefined)
      console.log(
        `[PERF] +${(performance.now() - t0).toFixed(0)}ms TabbedTerminal first render (${visibleSessions.length} sessions)`,
      );
  }

  const tabCreationLockRef = useRef(false);
  const [pendingTabCreation, setPendingTabCreation] = useState<{
    kind: 'claude' | 'codex' | 'copilot' | 'terminal';
    targetKey: string | null;
    targetShellId: string | null;
    targetProcessId: string | null;
  } | null>(null);

  const [historyModalOpen, setHistoryModalOpen] = useState(false);
  const [resumeByIdOpen, setResumeByIdOpen] = useState(false);
  // Harness capability state (cache warmed at app startup). Drives the "!"
  // sub-icon on the claude/codex openers and the harness-required popup.
  const claudeCapability = useCapability(CapabilityKinds.ClaudeCode);
  const codexCapability = useCapability(CapabilityKinds.Codex);
  const copilotCapability = useCapability(CapabilityKinds.Copilot);
  const [installChoiceKinds, setInstallChoiceKinds] = useState<string[] | null>(null);
  // askInstallOneOf — open the harness-required popup for the given capability kinds.
  const askInstallOneOf = useCallback((kinds: string[]) => setInstallChoiceKinds(kinds), []);
  const { resumeInTerminal } = useResumeInTerminal();

  const { navigation, currentDock } = useDockNavigation();

  // Active tab is URL-derived. The URL is the single source of truth:
  // click → navigate(url) → loader → context → render. We parse currentDock
  // (set by react-router from the live URL params), NOT dataContext fields
  // that were set optimistically on the click path — those would re-introduce
  // the "tab highlights before URL changes" inversion called out in CLAUDE.md.
  const urlActiveTargetTypeId = useMemo<TypeId | null>(() => {
    if (currentDock?.viewType !== ViewType.SHELL || !currentDock.pointer) return null;
    return DockPointer.terminalTargetTypeIdForShellPointer(currentDock.pointer);
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
    const pointer = terminalDockPointer(target);
    if (pointer) navigation.openDockPointer(pointer);
  }, [hasActiveTab, visibleSessions, navigation]);

  const clearPendingTabCreation = useCallback(() => {
    tabCreationLockRef.current = false;
    setPendingTabCreation(null);
  }, []);

  // "Start Claude" button — creates AgenticProcess entity, then emits onTabOpen
  // so the consumer can navigate / tag / start.
  // `launch` overrides the project the process is pinned to (and its workdir);
  // used by the projects-counter chip to start a tab on a not-yet-open project.
  const startAgenticTab = useCallback(
    async (
      kind: 'claude' | 'codex' | 'copilot',
      workerType?: 'claude_code' | 'codex' | 'copilot',
      launch?: { projectId: string; cwd?: string | null },
    ) => {
      if (tabCreationLockRef.current) return;
      tabCreationLockRef.current = true;
      setPendingTabCreation({ kind, targetKey: null, targetShellId: null, targetProcessId: null });
      // Harness gate: validate the exact requested worker harness before
      // creating a process that can only fail at PTY spawn.
      try {
        const requiredKind =
          workerType === 'codex'
            ? CapabilityKinds.Codex
            : workerType === 'claude_code'
              ? CapabilityKinds.ClaudeCode
              : CapabilityKinds.Harness;
        const harness = await capabilityManager.ensureChecked(requiredKind);
        if (harness.checked && !harness.available) {
          askInstallOneOf([...HARNESS_CAPABILITY_KINDS]);
          clearPendingTabCreation();
          return;
        }
      } catch {
        // Capability API unavailable (older backend) — don't block tab creation.
      }
      const launchProjectId = launch?.projectId ?? spawnProjectId;
      const result = await navigation.openNewClaudeProcess({
        ...(launchProjectId ? { projectId: launchProjectId } : {}),
        ...(launch?.cwd ? { cwd: launch.cwd } : {}),
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
    [askInstallOneOf, clearPendingTabCreation, navigation, onTabOpen, pushTerminal, spawnProjectId],
  );

  const handleStartClaude = useCallback(() => startAgenticTab('claude', 'claude_code'), [startAgenticTab]);
  const handleStartCodex = useCallback(() => startAgenticTab('codex', 'codex'), [startAgenticTab]);
  const handleStartCopilot = useCallback(() => startAgenticTab('copilot', 'copilot'), [startAgenticTab]);

  // Projects-counter chip → "Open another project…" pick. Ensure the Project
  // entity exists for the picked path (no context switch / navigation — the
  // launched process drives navigation URL-first via onTabOpen), then start
  // an agentic tab of the picked worker type pinned to it. The new bucket
  // appears in the chip's list automatically once the tab lands in
  // terminalState.
  const ensureProject = useEnsureProject();
  const handleLaunchProjectPath = useCallback(
    async (cwd: string, workerType: ProjectWorkerType) => {
      try {
        const project = await ensureProject(cwd, { select: false });
        await startAgenticTab(workerType === 'codex' ? 'codex' : workerType === 'copilot' ? 'copilot' : 'claude', workerType, {
          projectId: project.id,
          cwd: project.fs_storage_mount_path,
        });
      } catch (error) {
        notify.error({
          title: 'Failed to open project',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [ensureProject, startAgenticTab],
  );

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
  const sessionsRef = useRef(visibleSessions);
  sessionsRef.current = visibleSessions;
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

  // Scroll-into-view on active change is owned by TabStrip; selecting a tab
  // is just the URL-first navigation emit.
  const selectTab = useCallback(
    (targetKey: string) => {
      if (!targetKey) return;
      navigateToSession(targetKey);
    },
    [navigateToSession],
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
      // Don't write dataContext here — the consumer's onTabOpen already called
      // navigation.openDock(pointer) and the loader owns the context writes.
      // TabStrip scroll-into-view follows the resulting active-key change.
      clearPendingTabCreation();
    }
  }, [visibleSessions, pendingTabCreation, clearPendingTabCreation]);

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

  const handleCloseMany = useCallback(
    (keys: string[]) => {
      const keySet = new Set(keys);
      void closeTabs(visibleSessions.filter((s) => keySet.has(terminalTargetKey(s))));
    },
    [visibleSessions, closeTabs],
  );

  /**
   * Pop a tab out to a chrome-less `win/` focus window (tab-management.md
   * Part 3 §§7-8): `openDockInWindow` builds the win/ URL — web → new browser
   * tab, Electron → in-app BrowserWindow via the setWindowOpenHandler
   * carve-out. The origin then detaches only after the win window announced
   * ready on the handoff channel (or its 10s UX fallback elapsed). The strip
   * chip itself is untouched — `tabbed` is membership, not placement (§8).
   * The backend session must stay alive — closing it would kill the PTY for
   * the popped-out window too (it is one shared session), so this
   * deliberately does NOT go through the close path.
   */
  const handleOpenExternalTab = useCallback(
    (targetKey: string) => {
      const session = visibleSessions.find((s) => terminalTargetKey(s) === targetKey);
      const pointer = session && terminalDockPointer(session);
      if (!pointer) return;
      navigation.openDockInWindow(pointer);
      // Detach this window only if it is currently viewing the popped-out
      // tab — and only once the win window signalled ready (true) or the
      // fallback elapsed (false): hand the remaining alive tabs to the
      // shared resolver (same MRU/order precedence as the strip's
      // self-heal), or close the dock when none remain.
      if (activeTargetKey !== targetKey) return;
      void waitForWinReady(targetKey).then(() => {
        const remaining = visibleSessions.filter((s) => terminalTargetKey(s) !== targetKey && !s.isDisabled);
        const { activeKey } = resolveActive({
          candidates: buildTabCandidates(remaining),
          urlActiveKey: null,
          pendingIntentKey: null,
        });
        const next = remaining.find((s) => terminalTargetKey(s) === activeKey);
        const nextPointer = next && terminalDockPointer(next);
        if (nextPointer) navigation.openDockPointer(nextPointer);
        else navigation.closeDock();
      });
    },
    [visibleSessions, navigation, activeTargetKey],
  );

  // Rename commit from TabStrip (input UI lives in the strip; validation and
  // the entity/PTY save — the terminal rename strategy — live here).
  const handleRenameCommit = (targetKey: string, newName: string) => {
    const session = visibleSessions.find((s) => terminalTargetKey(s) === targetKey);
    if (session?.shell) onTabRename(session, newName);
  };

  const onTabRename = (
    session: TerminalTab,
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

  // Use Ctrl key on Mac, Win key on Windows, Alt key on Linux
  const osPlatform: string =
    (navigator as Navigator & { userAgentData?: { platform: string } }).userAgentData?.platform ?? navigator.userAgent;
  const modKey = /Mac/i.test(osPlatform) ? 'Ctrl' : /Win/i.test(osPlatform) ? 'Meta' : 'Alt';
  const modLabel = /Mac/i.test(osPlatform) ? 'Ctrl' : /Win/i.test(osPlatform) ? 'Win' : 'Alt';

  // Intercept mod+W (close tab), mod+T (new Claude), mod+PgUp/PgDn (cycle tabs)
  useEffect(() => {
    if (!enableShortcuts) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      // Two controller instances can be live at once (the unified content-panel
      // strip + an embedded TabbedTerminal view). Handlers preventDefault when
      // they act, so the guard makes the second instance a no-op instead of a
      // double create/close.
      if (e.defaultPrevented) return;
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
  }, [activeTargetKey, handleStartTerminal, handleStartClaude, visibleSessions, selectTab, handleCloseTab, modKey, enableShortcuts]);

  const isTabCreationPending = pendingTabCreation !== null;
  const isClaudeCreationPending = pendingTabCreation?.kind === 'claude';
  const isCodexCreationPending = pendingTabCreation?.kind === 'codex';
  const isCopilotCreationPending = pendingTabCreation?.kind === 'copilot';
  const isTerminalCreationPending = pendingTabCreation?.kind === 'terminal';
  const sandboxAvailable = !!dataContext.bootstrapInfo?.sandbox_available && !!dataContext.sandboxComputeNode;
  const dockerNodes = dataContext.dockerComputeNodes;
  const claudeWarning = harnessWarning(claudeCapability);
  const codexWarning = harnessWarning(codexCapability);
  const copilotWarning = harnessWarning(copilotCapability);
  const openers = useMemo<OpenerDescriptor[]>(() => {
    const list: OpenerDescriptor[] = [
      {
        id: 'claude',
        label: `Start Claude (${modLabel}+C)`,
        Icon: PROVIDER_META.claude.Icon,
        iconClassName: PROVIDER_META.claude.iconClassName,
        onActivate: () => {
          void handleStartClaude();
        },
        available: true,
        // Warned opener: the toolbar's activate() routes to the Capabilities
        // screen instead of launching.
        warning: claudeWarning,
        pendingInline: isClaudeCreationPending,
        disabled: isTabCreationPending,
      },
      {
        id: 'codex',
        label: 'Start Codex',
        Icon: PROVIDER_META.codex.Icon,
        iconClassName: PROVIDER_META.codex.iconClassName,
        onActivate: () => {
          void handleStartCodex();
        },
        available: true,
        warning: codexWarning,
        pendingInline: isCodexCreationPending,
        disabled: isTabCreationPending,
      },
      {
        id: 'copilot',
        label: 'Start Copilot',
        Icon: PROVIDER_META.copilot.Icon,
        iconClassName: PROVIDER_META.copilot.iconClassName,
        onActivate: () => {
          void handleStartCopilot();
        },
        available: true,
        warning: copilotWarning,
        pendingInline: isCopilotCreationPending,
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
    handleStartCopilot,
    handleStartTerminal,
    handleStartSandbox,
    handleStartDocker,
    sandboxAvailable,
    dockerNodes,
    claudeWarning,
    codexWarning,
    copilotWarning,
    isClaudeCreationPending,
    isCodexCreationPending,
    isCopilotCreationPending,
    isTerminalCreationPending,
    isTabCreationPending,
  ]);

  const tabEndToolbar = useMemo(
    () =>
      addTabButton ? (
        <TerminalOpenerToolbar openers={openers} isTabCreationPending={isTabCreationPending} />
      ) : null,
    [addTabButton, openers, isTabCreationPending],
  );

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

  // Strip items: the kind-agnostic chip descriptors TabStrip renders. The
  // vendor icon override (claude/codex/copilot/terminal) is the terminal
  // strategy's icon resolution (Part 3 §6), via the PROVIDER_META table.
  const stripItems: TabStripItem[] = useMemo(() => visibleSessions.map((session) => {
    const targetKey = terminalTargetKey(session);
    const sessionProcess =
      terminalProcessId(session) && contextAgenticProcess?.id === terminalProcessId(session)
        ? contextAgenticProcess
        : session.agenticProcess;
    const workerType = sessionProcess?.worker_type?.toLowerCase() ?? '';
    const providerKind: keyof typeof PROVIDER_META =
      session.targetTypeId.type === Shell.type
        ? 'shell'
        : workerType === 'codex'
          ? 'codex'
          : workerType === 'copilot'
            ? 'copilot'
            : 'claude';
    const { Icon: ProviderIcon, iconClassName: providerIconClassName, label: providerLabel } =
      PROVIDER_META[providerKind];
    const tabTestId =
      session.targetTypeId.type === Shell.type ? `tab-shell-${session.targetTypeId.id}` : `tab-shell-${targetKey}`;
    const indicatorKey = session.targetTypeId.type === Shell.type ? session.targetTypeId.id : targetKey;
    const sessionProcessId = terminalProcessId(session);
    return {
      key: targetKey,
      title: getDisplayName(session),
      icon: (
        <ProviderIcon
          className={`h-3.5 w-3.5 shrink-0 ${providerIconClassName}`}
          data-testid={`tab-provider-icon-${indicatorKey}`}
          data-provider={providerKind}
          aria-label={providerLabel}
        />
      ),
      badge: sessionProcess?.cliOptions?.worktree ? (
        <FolderGit2 className="h-3 w-3 shrink-0 text-amber-500" />
      ) : undefined,
      isDisabled: session.isDisabled,
      statusReason: session.statusReason,
      isPending: sessionProcessId ? pendingProcessIds.has(sessionProcessId) : false,
      renameable: true,
      tooltip: sessionProcess ? (
        <ProcessInfoTooltip
          process={sessionProcess}
          statusReason={session.isDisabled ? session.statusReason : undefined}
        />
      ) : undefined,
      testId: tabTestId,
      dataAttributes: { 'data-indicator-key': indicatorKey },
    };
  }), [visibleSessions, pendingProcessIds, contextAgenticProcess]);

  const handleSelect = useCallback(
    (key: string) => {
      const session = sessionsRef.current.find((s) => terminalTargetKey(s) === key);
      selectTab(key);
      if (session) acknowledgePending(terminalProcessId(session));
    },
    [selectTab],
  );

  const newTabMenuItems = useMemo<TabStripContextMenuItem[]>(
    () => [
      { label: 'New Claude Session', shortcut: `${modLabel}+C`, onSelect: () => void handleStartClaude() },
      { label: 'New Terminal', shortcut: `${modLabel}+T`, onSelect: () => void handleStartTerminal() },
    ],
    [modLabel, handleStartClaude, handleStartTerminal],
  );

  const leading = useMemo(
    () => (
      <ProjectsCounterChip
        currentProjectId={tabsProjectId}
        onLaunchProjectPath={handleLaunchProjectPath}
        onOpenHistory={() => setHistoryModalOpen(true)}
      />
    ),
    [tabsProjectId, handleLaunchProjectPath],
  );

  const modals = (
    <>
      <AskInstallOneOfDialog kinds={installChoiceKinds} onClose={() => setInstallChoiceKinds(null)} />
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
                  message: `Session ${entry.worker_id} is not in Claude, Codex, or Copilot history.`,
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
    </>
  );

  return {
    visibleSessions,
    activeTargetKey,
    mountedTargetKeys,
    contextAgenticProcess,
    tabsProjectId,
    stripItems,
    handleSelect,
    handleCloseTab,
    handleCloseMany,
    handleRenameCommit,
    handleOpenExternalTab,
    onTabRename,
    newTabMenuItems,
    closeShortcutLabel: `${modLabel}+W`,
    leading,
    trailing: tabEndToolbar,
    modals,
    isTabCreationPending,
    isClaudeCreationPending,
    isTerminalCreationPending,
    handleStartClaude,
    handleStartTerminal,
  };
}
