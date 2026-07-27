import { EntityExecutionPanel } from '@src/components/entity-execution-panel';
import { VibeAssignTaskButton } from './VibeAssignTaskButton';
import { VibeCollaborateButton } from './VibeCollaborateButton';
import { embedVibeAgent } from './use-start-vibe-session';
import { ViewMode } from '@src/contexts/view-mode-context';
import { useAgentContext } from '@src/contexts/agent-context';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { normalizeVibeModelTier, VIBE_MODEL_DEFAULT, VibeModelSelect } from './vibe-model-select';
import { VibeWorkerSelect } from './vibe-worker-select';
import { normalizeWorkerType } from '@src/components/workers/worker-types';
import { useDefaultWorkerType } from '@src/contexts/HarnessCapabilitiesContext';
import { AgenticProcess, ProcessKind } from '@sdk';
import { Plus } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import type { AssetWorkContext } from './asset-work-context';
import { useKeyedAssetPromptContext } from './asset-work-context';

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

  return (
    <EntityExecutionPanel
        target={process?.target_typeid_str ?? null}
        processType={ProcessKind.Chat}
        className="h-full border-r border-border"
        dense
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
          <>
            <VibeAssignTaskButton
              projectId={project?.id ?? null}
              sessionTypeId={process?.typeId ?? null}
            />
            <VibeCollaborateButton
              projectId={project?.id ?? null}
              sessionTypeId={process?.typeId ?? null}
            />
          </>
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
  );
}
