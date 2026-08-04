import { EntityExecutionPanel } from '@src/components/entity-execution-panel';
import { VibeAssignTaskButton } from './VibeAssignTaskButton';
import {
  continueVibeSessionForProject,
  createVibeProcessForProject,
  embedVibeAgent,
  vibeChatTargetForProject,
} from './use-start-vibe-session';
import { ViewMode } from '@src/contexts/view-mode-context';
import { useAgentContext } from '@src/contexts/agent-context';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { notify } from '@src/notifications/notify';
import {
  normalizeVibeModelTier,
  VIBE_MODEL_DEFAULT,
  VibeModelSelect,
  type VibeModelTier,
} from './vibe-model-select';
import { VibeWorkerSelect } from './vibe-worker-select';
import { normalizeWorkerType, type WorkerType } from '@src/components/workers/worker-types';
import { useDefaultWorkerType } from '@src/contexts/HarnessCapabilitiesContext';
import { AgenticProcess, ProcessKind } from '@sdk';
import { Plus } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import type { AssetWorkContext } from './asset-work-context';
import { useKeyedAssetPromptContext } from './asset-work-context';
import {
  VibeWorkerSwitchDialog,
  type VibeWorkerSwitchIntent,
} from './VibeWorkerSwitchDialog';

interface VibeChatPaneProps {
  process: AgenticProcess | null;
  workContext?: AssetWorkContext | null;
}

/** Process-bound chat shared by the process Display and asset-child shells. */
export function VibeChatPane({ process, workContext = null }: VibeChatPaneProps) {
  const { t } = useLingui();
  const { project } = useAgentContext();
  const { navigation } = useDockNavigation();
  const defaultWorkerType = useDefaultWorkerType();
  const { promptContext, consume } = useKeyedAssetPromptContext(workContext);
  const [pendingWorkerSwitch, setPendingWorkerSwitch] = useState<{
    workerType: WorkerType;
    model: VibeModelTier;
    sourceProcess: AgenticProcess;
    projectId: string | null;
    workdir: string | null | undefined;
  } | null>(null);
  const [workerSwitchIntent, setWorkerSwitchIntent] =
    useState<VibeWorkerSwitchIntent | null>(null);

  // A process created OUTSIDE the vibe flow — e.g. a plain shell/PTY tab opened
  // in vibe mode — carries no `target_typeid_str`, and a null target hard-disables
  // the composer (EntityExecutionPanel's documented contract). Key it to the
  // project it already belongs to, the same way the vibe flow would have.
  // Strictly a *process has no target* compensation: with no process resolved
  // yet there is nothing to host, so stay null rather than opening a composer
  // that would lazily mint a session.
  const chatTarget = !process
    ? null
    : process.target_typeid_str ??
      (process.project_id ? vibeChatTargetForProject(process.project_id) : null);

  const handleActiveWorkerChange = useCallback(
    ({
      workerType,
      activeProcess,
      model,
      projectId,
      workdir,
    }: {
      workerType: WorkerType;
      activeProcess: AgenticProcess;
      model: string | null;
      projectId: string | null;
      workdir: string | null | undefined;
    }) => {
      setPendingWorkerSwitch({
        workerType,
        model: normalizeVibeModelTier(model),
        sourceProcess: activeProcess,
        projectId,
        workdir,
      });
    },
    [],
  );

  const runWorkerSwitch = useCallback(async (intent: VibeWorkerSwitchIntent) => {
    const pending = pendingWorkerSwitch;
    if (!pending || !pending.projectId || workerSwitchIntent) return;
    setWorkerSwitchIntent(intent);
    const options = {
      projectId: pending.projectId,
      workdir: pending.workdir ?? undefined,
      navigation,
      model: pending.model,
      workerType: pending.workerType,
      targetVfsPath: pending.sourceProcess.target_typeid_str ?? undefined,
    };
    try {
      if (intent === 'continue') {
        await continueVibeSessionForProject({
          ...options,
          sourceProcess: pending.sourceProcess,
        });
      } else {
        await createVibeProcessForProject(options);
      }
      setPendingWorkerSwitch(null);
    } catch (error) {
      console.error('[Vibe] Failed to switch worker:', error);
      notify.error({ title: t`Could not start`, message: t`Failed to start the build session.` });
    } finally {
      setWorkerSwitchIntent(null);
    }
  }, [
    navigation,
    pendingWorkerSwitch,
    t,
    workerSwitchIntent,
  ]);

  return (
    <>
      <EntityExecutionPanel
        target={chatTarget}
        processType={ProcessKind.Chat}
        className="h-full border-r border-border"
        dense
        allowAttachments
        leadingSlot={({ startNewSession }) => (
          <button
            type="button"
            onClick={startNewSession}
            title={t`New build`}
            data-testid="entity-execution-new"
            className="inline-flex h-6 items-center gap-1 rounded-full border border-green-500/30 bg-green-500/10 px-2 text-xs font-medium text-green-600 transition-colors hover:bg-green-500/20 hover:text-green-700 dark:text-green-400 dark:hover:text-green-300"
          >
            <Plus className="h-3 w-3" />
            {t`New`}
          </button>
        )}
        emptyStateText={t`What do you want to work on`}
        newSessionLabel={t`New build`}
        historyLabel={t`Build history`}
        historyTriggerLabel={t`Recent`}
        historyOnLeft
        showProcessNameBar
        afterHistorySlot={
          <VibeAssignTaskButton
            projectId={project?.id ?? null}
            sessionTypeId={process?.typeId ?? null}
          />
        }
        pastSessionsLabel={t`Past builds`}
        noPastSessionsLabel={t`No past builds`}
        defaultProjectId={project?.id ?? null}
        defaultWorkdir={project?.fs_storage_mount_path ?? null}
        defaultModel={VIBE_MODEL_DEFAULT}
        defaultWorkerType={defaultWorkerType}
        modelSelectSlot={({ value, disabled, onChange }) => (
          <VibeModelSelect
            value={normalizeVibeModelTier(value)}
            onChange={(next) => onChange(next)}
            disabled={disabled}
          />
        )}
        workerSelectSlot={({ value, disabled, onChange }) => (
          <VibeWorkerSelect
            value={normalizeWorkerType(value)}
            onChange={(next) => onChange(next)}
            disabled={disabled || !project?.id}
          />
        )}
        onActiveWorkerChange={handleActiveWorkerChange}
        initialProcessId={process?.id ?? null}
        promptContext={
          promptContext
            ? { label: t`Working on ${promptContext.label}`, text: promptContext.text }
            : null
        }
        onPromptContextConsumed={
          promptContext ? () => consume(promptContext.key) : undefined
        }
        onProcessSelected={(processId) => {
          void navigation.openShellProcess(processId, { viewMode: ViewMode.Vibe });
        }}
        onProcessCreated={async (newProcess) => {
          await newProcess.enableAssistant();
          await embedVibeAgent(newProcess);
          void navigation.openShellProcess(newProcess.id, { viewMode: ViewMode.Vibe });
        }}
      />
      <VibeWorkerSwitchDialog
        open={!!pendingWorkerSwitch}
        workerType={pendingWorkerSwitch?.workerType ?? defaultWorkerType}
        inFlight={workerSwitchIntent}
        onStartNew={() => void runWorkerSwitch('new')}
        onContinue={() => void runWorkerSwitch('continue')}
        onCancel={() => {
          if (!workerSwitchIntent) setPendingWorkerSwitch(null);
        }}
      />
    </>
  );
}
