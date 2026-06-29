/**
 * useTerminalStripController — the terminal-strip CHROME (docs/tab-management.md
 * Part 3 §6). After the Tab-entity cutover the strip itself is the shared
 * `UnifiedTabStrip` (rows from the `tab` action, chips from `tab-row-item`), and
 * the terminal body is `TabbedTerminal`; both derive order/label/active from the
 * one backend source. This hook owns only the chrome neither of them computes:
 *
 *   - spawn flows (claude/codex/copilot/terminal/sandbox/docker) + harness gating
 *   - the opener toolbar (`trailing`), the new-tab menu, and the empty-state
 *     spawn handlers
 *   - the `ProjectsCounterChip` (`leading`)
 *   - the history / resume / install modals
 *
 * It holds NO session list, active-key, or close/rename/select handlers — those
 * are URL-first in `UnifiedTabStrip`. Spawns navigate directly to the new
 * terminal (no host callback round-trip).
 */
import {
  AgenticProcess,
  capabilityManager,
  CapabilityKinds,
  ContextEntitiesEnum,
  dataContext,
  GraphContext,
  HARNESS_CAPABILITY_KINDS,
  type ComputeNode,
} from '@sdk';
import { type UseCapabilityResult } from '@sdk/react/hooks';
import { useIsAdvanced } from '@src/contexts/view-mode-context';
import { DockPointer } from '@src/navigation/DockPointer';
import { useHarnessCapabilities } from '@src/contexts/HarnessCapabilitiesContext';
import { ClaudeIcon } from '@src/components/icons/ClaudeIcon';
import { useEnsureProject } from '@src/components/project-selector';
import { InputDialog } from '@src/components/ui/input-dialog';
import { type TabStripContextMenuItem } from '@src/components/tabs/TabStrip';
import { useResumeInTerminal } from '@src/hooks/use-resume-in-terminal';
import { notify } from '@src/notifications';
import { PROVIDER_META } from '@src/tabs/provider-meta';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { Cloud, Container, History, SquareTerminal } from 'lucide-react';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { HistoryModal } from '@src/components/terminal/HistoryModal';
import { ProjectsCounterChip, type ProjectWorkerType } from '@src/components/terminal/ProjectsCounterChip';
import { AskInstallOneOfDialog } from '@src/components/terminal/openers/AskInstallOneOfDialog';
import { TerminalOpenerToolbar } from '@src/components/terminal/openers/TerminalOpenerToolbar';
import type { OpenerDescriptor } from '@src/components/terminal/openers/tab_opener_types';

const ClaudeResumeIcon: React.FC<{ className?: string }> = ({ className }) => (
  <span className={`relative inline-flex items-center justify-center ${className ?? ''}`}>
    <ClaudeIcon className="!h-4 !w-4 text-orange-500" />
    <History className="absolute -bottom-0.5 -right-0.5 !h-2.5 !w-2.5 text-foreground/80" strokeWidth={3} />
  </span>
);

/** Opener warning for a harness: set when its backend capability check ran and failed. */
function harnessWarning(capability: UseCapabilityResult): string | null {
  if (!capability.checked || capability.available) return null;
  return capability.result?.message ?? 'This harness is not available on this machine.';
}

export interface TerminalStripControllerOptions {
  /** Whether to expose the "Add Tab" opener toolbar as `trailing`. */
  addTabButton?: boolean;
  /** Pin spawned shells/processes to this project (else the active project). */
  spawnProjectId?: string | null;
}

export interface TerminalStripController {
  /** The project the chrome is scoped to (strip list scope). */
  tabsProjectId: string | null;
  newTabMenuItems: TabStripContextMenuItem[];
  closeShortcutLabel: string;
  /** Leading fixed node (ProjectsCounterChip). */
  leading: React.ReactNode;
  /** Trailing opener toolbar (null unless `addTabButton`). */
  trailing: React.ReactNode;
  /** History / resume / install dialogs — render once in the host. */
  modals: React.ReactNode;
  isTabCreationPending: boolean;
  isClaudeCreationPending: boolean;
  isTerminalCreationPending: boolean;
  handleStartClaude: () => Promise<void> | void;
  handleStartTerminal: () => Promise<void> | void;
  handleOpenHistory: () => void;
}

export function useTerminalStripController({
  addTabButton,
  spawnProjectId,
}: TerminalStripControllerOptions = {}): TerminalStripController {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const isAdvanced = useIsAdvanced();
  // Per-type icon from the backend TypeInfo registry (never hardcode a glyph).
  // Memoized so it stays referentially stable and doesn't churn the openers /
  // newTabMenuItems memos on every render.
  const ContextIcon = useMemo(() => iconForType(GraphContext.type), []);
  const tabsProjectId = spawnProjectId ?? dataContext.project?.id ?? null;
  const currentProjectName = spawnProjectId
    ? null
    : (dataContext.project?.getDisplayName() ?? dataContext.project?.name ?? null);

  const tabCreationLockRef = useRef(false);
  const [pendingTabCreation, setPendingTabCreation] = useState<
    'claude' | 'codex' | 'copilot' | 'terminal' | null
  >(null);
  const [historyModalOpen, setHistoryModalOpen] = useState(false);
  const [resumeByIdOpen, setResumeByIdOpen] = useState(false);
  const { claude: claudeCapability, codex: codexCapability, copilot: copilotCapability } = useHarnessCapabilities();
  const [installChoiceKinds, setInstallChoiceKinds] = useState<string[] | null>(null);
  const askInstallOneOf = useCallback((kinds: string[]) => setInstallChoiceKinds(kinds), []);
  const { resumeInTerminal } = useResumeInTerminal();

  const clearPending = useCallback(() => {
    tabCreationLockRef.current = false;
    setPendingTabCreation(null);
  }, []);

  // "Start <vendor>" — create the AgenticProcess then navigate to its terminal.
  // `launch` overrides the project the process is pinned to (projects-chip path).
  const startAgenticTab = useCallback(
    async (
      kind: 'claude' | 'codex' | 'copilot',
      workerType?: 'claude_code' | 'codex' | 'copilot',
      launch?: { projectId: string; cwd?: string | null },
    ) => {
      if (tabCreationLockRef.current) return;
      tabCreationLockRef.current = true;
      setPendingTabCreation(kind);
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
          clearPending();
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
        clearPending();
        return;
      }
      // URL-first: navigate to the new process's terminal; the loader materializes
      // its Tab and the strip/body re-render from the one source.
      await navigation.openShellProcess(result.processId);
      clearPending();
    },
    [askInstallOneOf, clearPending, navigation, spawnProjectId],
  );

  const handleStartClaude = useCallback(() => startAgenticTab('claude', 'claude_code'), [startAgenticTab]);
  const handleStartCodex = useCallback(() => startAgenticTab('codex', 'codex'), [startAgenticTab]);
  const handleStartCopilot = useCallback(() => startAgenticTab('copilot', 'copilot'), [startAgenticTab]);

  const ensureProject = useEnsureProject();
  const handleLaunchProjectPath = useCallback(
    async (cwd: string, workerType: ProjectWorkerType) => {
      try {
        const project = await ensureProject(cwd, { select: false });
        await startAgenticTab(
          workerType === 'codex' ? 'codex' : workerType === 'copilot' ? 'copilot' : 'claude',
          workerType,
          { projectId: project.id, cwd: project.fs_storage_mount_path },
        );
      } catch (error) {
        notify.error({
          title: t`Failed to open project`,
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
      setPendingTabCreation('terminal');
      const result = await navigation.openNewShell({
        ...(computeNode ? { computeNode } : {}),
        ...(spawnProjectId ? { projectId: spawnProjectId } : {}),
        skipNavigate: true,
      });
      if (!result?.shellId) {
        clearPending();
        return;
      }
      await navigation.openShell(result.shellId);
      clearPending();
    },
    [clearPending, navigation, spawnProjectId],
  );

  const handleStartTerminal = useCallback(() => startTerminalTab(), [startTerminalTab]);

  // "Open Context" — freeze the current global context (the ContextEntitiesEnum
  // slots) into a new GraphContext entity and open it in a tab. URL-first: we
  // create the entity then navigate; no optimistic context writes.
  const handleOpenContext = useCallback(async () => {
    const slotMap: Record<string, string> = {};
    const typeids: string[] = [];
    for (const key of Object.values(ContextEntitiesEnum)) {
      const tid = dataContext.getContextEntityTypeId(key);
      if (!tid) continue;
      const s = tid.toString();
      slotMap[key] = s;
      typeids.push(s);
    }
    const scope = dataContext.project?.typeId ? [dataContext.project.typeId] : [];
    const gc = new GraphContext({});
    gc.context_typeids = typeids;
    gc.slot_map = slotMap;
    gc.name = `Context ${gc.id.slice(0, 8)}`;
    try {
      await gc.save(scope);
    } catch (e) {
      // Surface the failure instead of silently doing nothing — the most common
      // cause is a backend that predates the graph_context type (needs restart).
      notify.error({
        title: t`Could not freeze context`,
        message: e instanceof Error ? e.message : t`Failed to save the context snapshot.`,
      });
      return;
    }
    navigation.openDock(DockPointer.forGraphContext(gc.typeId.id));
  }, [navigation]);

  const handleStartSandbox = useCallback(() => {
    const sandboxNode = dataContext.sandboxComputeNode;
    if (!sandboxNode) return;
    return startTerminalTab(sandboxNode);
  }, [startTerminalTab]);
  const handleStartDocker = useCallback((dockerNode: ComputeNode) => startTerminalTab(dockerNode), [startTerminalTab]);

  // Use Ctrl key on Mac, Win key on Windows, Alt key on Linux (label only).
  const osPlatform: string =
    (navigator as Navigator & { userAgentData?: { platform: string } }).userAgentData?.platform ?? navigator.userAgent;
  const modLabel = /Mac/i.test(osPlatform) ? 'Ctrl' : /Win/i.test(osPlatform) ? 'Win' : 'Alt';

  const isTabCreationPending = pendingTabCreation !== null;
  const isClaudeCreationPending = pendingTabCreation === 'claude';
  const isCodexCreationPending = pendingTabCreation === 'codex';
  const isCopilotCreationPending = pendingTabCreation === 'copilot';
  const isTerminalCreationPending = pendingTabCreation === 'terminal';
  const sandboxAvailable = !!dataContext.bootstrapInfo?.sandbox_available && !!dataContext.sandboxComputeNode;
  const dockerNodes = dataContext.dockerComputeNodes;
  const claudeWarning = harnessWarning(claudeCapability);
  const codexWarning = harnessWarning(codexCapability);
  const copilotWarning = harnessWarning(copilotCapability);

  const openers = useMemo<OpenerDescriptor[]>(
    () => [
      {
        id: 'claude',
        label: t`Start Claude (${modLabel}+C)`,
        Icon: PROVIDER_META.claude.Icon,
        iconClassName: PROVIDER_META.claude.iconClassName,
        onActivate: () => void handleStartClaude(),
        available: true,
        warning: claudeWarning,
        pendingInline: isClaudeCreationPending,
        disabled: isTabCreationPending,
      },
      {
        id: 'codex',
        label: t`Start Codex`,
        Icon: PROVIDER_META.codex.Icon,
        iconClassName: PROVIDER_META.codex.iconClassName,
        onActivate: () => void handleStartCodex(),
        available: true,
        warning: codexWarning,
        pendingInline: isCodexCreationPending,
        disabled: isTabCreationPending,
      },
      {
        id: 'copilot',
        label: t`Start Copilot`,
        Icon: PROVIDER_META.copilot.Icon,
        iconClassName: PROVIDER_META.copilot.iconClassName,
        onActivate: () => void handleStartCopilot(),
        available: true,
        warning: copilotWarning,
        pendingInline: isCopilotCreationPending,
        disabled: isTabCreationPending,
      },
      {
        id: 'claude-resume-by-id',
        label: t`Resume Claude session…`,
        Icon: ClaudeResumeIcon,
        onActivate: () => setResumeByIdOpen(true),
        available: true,
        disabled: isTabCreationPending,
      },
      {
        id: 'terminal',
        label: t`Open terminal (${modLabel}+T)`,
        Icon: SquareTerminal,
        onActivate: () => void handleStartTerminal(),
        available: true,
        pendingInline: isTerminalCreationPending,
        disabled: isTabCreationPending,
      },
      {
        id: 'sandbox',
        label: t`Open sandbox terminal (E2B)`,
        Icon: Cloud,
        iconClassName: 'text-sky-500',
        onActivate: () => void handleStartSandbox(),
        available: sandboxAvailable,
        pendingInline: isTerminalCreationPending,
        disabled: isTabCreationPending,
      },
      {
        id: 'docker',
        label: t`Open docker terminal`,
        Icon: Container,
        iconClassName: 'text-blue-500',
        onActivate: () => {
          if (dockerNodes.length === 1) void handleStartDocker(dockerNodes[0]);
        },
        onDockerNodeSelect: (dockerNode) => void handleStartDocker(dockerNode),
        available: dockerNodes.length > 0,
        pendingInline: isTerminalCreationPending,
        disabled: isTabCreationPending,
        dockerNodes,
      },
      {
        id: 'history',
        label: t`Open from history`,
        Icon: History,
        onActivate: () => setHistoryModalOpen(true),
        available: true,
      },
      {
        // Advanced-only: freeze the current global context into a GraphContext.
        id: 'open-context',
        label: t`Open Context`,
        Icon: ContextIcon,
        onActivate: () => void handleOpenContext(),
        available: isAdvanced,
        disabled: isTabCreationPending,
      },
    ],
    [
      modLabel,
      handleStartClaude,
      handleStartCodex,
      handleStartCopilot,
      handleStartTerminal,
      handleStartSandbox,
      handleStartDocker,
      handleOpenContext,
      isAdvanced,
      ContextIcon,
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
    ],
  );

  const trailing = useMemo(
    () => (addTabButton ? <TerminalOpenerToolbar openers={openers} isTabCreationPending={isTabCreationPending} /> : null),
    [addTabButton, openers, isTabCreationPending],
  );

  const newTabMenuItems = useMemo<TabStripContextMenuItem[]>(
    () => [
      { label: t`New Claude Session`, shortcut: `${modLabel}+C`, onSelect: () => void handleStartClaude() },
      { label: t`New Terminal`, shortcut: `${modLabel}+T`, onSelect: () => void handleStartTerminal() },
      // Advanced-only: freeze the current context into a GraphContext and open it.
      ...(isAdvanced
        ? [{ label: t`Open Context`, Icon: ContextIcon, onSelect: () => void handleOpenContext() }]
        : []),
    ],
    [modLabel, handleStartClaude, handleStartTerminal, isAdvanced, handleOpenContext, ContextIcon],
  );

  const leading = useMemo(
    () => (
      <ProjectsCounterChip
        currentProjectId={tabsProjectId}
        currentProjectName={currentProjectName}
        onLaunchProjectPath={handleLaunchProjectPath}
        onOpenHistory={() => setHistoryModalOpen(true)}
      />
    ),
    [tabsProjectId, currentProjectName, handleLaunchProjectPath],
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
              let processId: string | null = entry.agentic_process_id;
              if (!processId) {
                const process = await AgenticProcess.getByWorkerId(entry.worker_id);
                processId = process?.id ?? null;
              }
              if (!processId) {
                notify.error({
                  title: t`Session not found`,
                  message: t`Session ${entry.worker_id} is not in Claude, Codex, or Copilot history.`,
                  id: `session-not-found:${entry.worker_id}`,
                });
                return;
              }
              await navigation.openShellProcess(processId);
            } catch (err) {
              console.error('[TabbedTerminal] Failed to open session from history:', err);
            }
          })();
        }}
      />
      <InputDialog
        open={resumeByIdOpen}
        onOpenChange={setResumeByIdOpen}
        title={t`Resume Claude session`}
        description={t`Paste a Claude CLI session id (UUID) to resume it in a new tab.`}
        placeholder="e.g. 0fa1a8c2-7b1d-4d6c-9d4e-b3e6c2f1d8aa"
        confirmLabel={t`Resume`}
        onConfirm={(sessionId) => resumeInTerminal(sessionId)}
      />
    </>
  );

  return {
    tabsProjectId,
    newTabMenuItems,
    closeShortcutLabel: `${modLabel}+W`,
    leading,
    trailing,
    modals,
    isTabCreationPending,
    isClaudeCreationPending,
    isTerminalCreationPending,
    handleStartClaude,
    handleStartTerminal,
    handleOpenHistory: () => setHistoryModalOpen(true),
  };
}
