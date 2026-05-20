import { MarkdownEditor } from '@src/components/assets/editor/markdown/MarkdownEditor';
import { enableMcp, isMcpAvailable } from '@src/components/assets/utils';
import type { ExtraSideTab } from '@src/components/milkdown-editor/EditorWithSidePanel';
import { WorkflowRunsPanel } from '@src/components/workflows-view/WorkflowRunsPanel';
import { WorkflowRunnerView } from '@src/components/workflow-runner';
import { useSpawnRunner } from '@src/components/workflow-runner/data/useSpawnRunner';
// WorkflowTraceViewer was the legacy "full pane drill into one run" view —
// replaced by the new <WorkflowRunnerView> mounted in the learning panel.
// Per-run navigation now happens via the RunStrip at the bottom of the
// runner view. `selectedRunId` URL param is preserved as a no-op for
// rollback safety; will be removed after one release.
import {
  workflowRunStore,
  type ProcessEntry,
} from '@src/components/workflows-view/workflow-run-store';
import { useProcessesForTarget } from '@src/components/entity-execution-panel';
import { RunButton } from '@src/components/assets/editor/run/RunButton';
import { Button } from '@src/components/ui/button';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@src/components/ui/alert-dialog';
import { useToast } from '@src/hooks/use-toast';
import { useEntityByPath } from '@src/hooks/use-entity-by-path';
import {
  AgenticProcess,
  FSRef,
  ProcessType,
  Workflow,
  dataContext,
} from '@sdk';
import { ClaudeCliOptions } from '@sdk/cli_workers/claude-cli';
import { History } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

const RUN_ID_PARAM = 'runId';

interface WorkflowAssetEditorProps {
  /** FSRef to the workflow's source markdown file. */
  fsRef: FSRef;
  /** Pre-resolved workflow entity. If omitted, resolved from `fsRef.path`. */
  workflow?: Workflow;
}

/**
 * Unified editor for workflow `.md` files. Mounted from both the wiki
 * (`AssetEditorRouter`) and the Workflows sidebar (`WorkflowsPage`) — one
 * surface, two entry points. Wraps `MarkdownEditor` and injects a `Run`
 * toolbar button + a `Runs` tab into its side drawer.
 *
 * Resolution: when mounted via `AssetEditorRouter`, the surrounding
 * `<EntityResolutionGate>` has already resolved the workflow and passes it
 * via `providedWorkflow`. Direct mounts (e.g. `WorkflowsPage`) also pass the
 * pre-resolved entity. As a fallback for any future caller that omits the
 * prop, `useEntityByPath` resolves it from `fsRef`.
 */
export function WorkflowAssetEditor({ fsRef, workflow: providedWorkflow }: WorkflowAssetEditorProps) {
  const { toast } = useToast();

  const { entity: discoveredWorkflow } = useEntityByPath<Workflow>(
    providedWorkflow ? null : Workflow.type,
    providedWorkflow ? null : fsRef,
  );
  const resolvedWorkflow = providedWorkflow ?? discoveredWorkflow;

  const [activeSideTab, setActiveSideTab] = useState<string>('editor');
  const [processEntry, setProcessEntry] = useState<ProcessEntry | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [showMcpModal, setShowMcpModal] = useState(false);
  const [mcpEnabling, setMcpEnabling] = useState(false);

  // When set, the main pane swaps from MarkdownEditor → WorkflowTraceViewer.
  // URL-bound via ?runId=<id> on the same DockPointer so the selection is
  // shareable + back-button-restorable, matching ?editorMode handling in
  // MarkdownEditor. Param name is `runId` to mirror /dev/trace/:runId.
  const { navigation, currentDock } = useDockNavigation();
  const selectedRunId = currentDock?.options?.[RUN_ID_PARAM] ?? null;
  const setSelectedRunId = useCallback(
    (runId: string | null) => {
      if (!currentDock) return;
      const nextOptions = { ...(currentDock.options ?? {}) };
      if (runId) {
        nextOptions[RUN_ID_PARAM] = runId;
      } else {
        delete nextOptions[RUN_ID_PARAM];
      }
      navigation.openDock(
        new DockPointer(currentDock.viewType, currentDock.pointer, nextOptions, currentDock.layout),
      );
    },
    [currentDock, navigation],
  );

  // WorkflowStrip's Play button stashes a live ProcessEntry here before
  // navigating — drain it on mount so we show the run in progress.
  useEffect(() => {
    if (!resolvedWorkflow?.id) return;
    const entry = workflowRunStore.get(resolvedWorkflow.id);
    if (entry) {
      setProcessEntry(entry);
      workflowRunStore.delete(resolvedWorkflow.id);
    }
  }, [resolvedWorkflow?.id]);

  const targetStr = useMemo(
    () => (resolvedWorkflow?.typeId ? resolvedWorkflow.typeId.toString() : ''),
    [resolvedWorkflow?.typeId],
  );
  const { processes: pastRunProcesses } = useProcessesForTarget(targetStr, {
    enabled: !!targetStr,
    processType: ProcessType.Execution,
  });

  const runHistory = useMemo<ProcessEntry[]>(() => {
    // created_date arrives as Date from watched queries but ISO string from
    // raw API JSON (useProcessesForTarget) — normalize before comparing.
    const toMs = (d: unknown): number => {
      if (d instanceof Date) return d.getTime();
      if (typeof d === 'string') return new Date(d).getTime() || 0;
      return 0;
    };
    const sorted = [...pastRunProcesses].sort(
      (a, b) => toMs(b.created_date) - toMs(a.created_date),
    );
    const liveId = processEntry?.process.id;
    return sorted.map((p) => (liveId && p.id === liveId ? processEntry! : { process: p }));
  }, [pastRunProcesses, processEntry]);

  const { spawn: spawnRunner } = useSpawnRunner();
  const doRun = useCallback(async () => {
    if (!resolvedWorkflow) return;
    const process = await spawnRunner({ workflow: resolvedWorkflow });
    if (process) {
      setProcessEntry({ process });
      setActiveSideTab('runs');
    }
  }, [resolvedWorkflow, spawnRunner]);

  const handleRun = useCallback(async () => {
    if (!resolvedWorkflow?.asset_ref) return;
    setIsStarting(true);
    try {
      const available = await isMcpAvailable('flow-sdk-mcp');
      if (!available) {
        setShowMcpModal(true);
        return;
      }
      await doRun();
    } catch (err) {
      console.error('[WorkflowAssetEditor] Run failed:', err);
      toast({ title: 'Failed to start workflow', variant: 'destructive' });
    } finally {
      setIsStarting(false);
    }
  }, [resolvedWorkflow, doRun, toast]);

  const handleEnableMcp = useCallback(
    async (scope: 'user' | 'project') => {
      setMcpEnabling(true);
      try {
        await enableMcp('flow-sdk-mcp', scope);
        setShowMcpModal(false);
        toast({ title: `flow-sdk-mcp enabled (${scope} scope). Starting workflow…` });
        await doRun();
      } catch (err) {
        console.error('[WorkflowAssetEditor] Enable MCP failed:', err);
        toast({ title: 'Failed to enable MCP', variant: 'destructive' });
      } finally {
        setMcpEnabling(false);
      }
    },
    [doRun, toast],
  );

  // The gate (`AssetEditorRouter`) only mounts us once the workflow is
  // resolved; direct mounts (`WorkflowsPage`) pass `providedWorkflow`. The
  // `useEntityByPath` fallback above covers stragglers — render nothing
  // while it settles.
  if (!resolvedWorkflow) return null;

  const isRunning = !!processEntry;

  const toolbar = (
    <RunButton
      onClick={() => void handleRun()}
      isRunning={isRunning}
      isStarting={isStarting}
      disabled={!resolvedWorkflow.asset_ref}
      title={
        !resolvedWorkflow.asset_ref
          ? 'No file linked'
          : isRunning
            ? 'Workflow running…'
            : 'Run workflow'
      }
    />
  );

  const runsTab: ExtraSideTab = {
    id: 'runs',
    label: runHistory.length > 0 ? `Runs ${runHistory.length}` : 'Runs',
    icon: History,
    description: 'Workflow runs',
    panel: (
      <WorkflowRunsPanel
        entries={runHistory}
        currentEntry={processEntry}
        computeNodeId={fsRef.typeId.id}
        onSelectRun={setSelectedRunId}
      />
    ),
  };

  // Filter to terminal-status processes with an output_folder. These are the
  // candidates the Learning view operates on (Analyze / Improve).
  const terminalRuns = useMemo(
    () =>
      runHistory
        .map((e) => e.process)
        .filter((p) => {
          const status = String(p.status ?? '').toLowerCase();
          return (status === 'stopped' || status === 'failed') && !!p.output_folder;
        }),
    [runHistory],
  );
  const showLearningMode = terminalRuns.length > 0;
  const learningPanel = showLearningMode ? (
    <WorkflowRunnerView workflow={resolvedWorkflow} runs={terminalRuns} />
  ) : null;

  // selectedRunId is now a soft hint — when set by a deep link from
  // WorkflowRunsPanel, we drop into learning mode. The actual per-run
  // selection lives in WorkflowRunnerView's useRunSelection (?runs= URL).
  void selectedRunId;
  void setSelectedRunId;

  return (
    <>
      <MarkdownEditor
        fsRef={resolvedWorkflow.doc ?? fsRef}
        chatTarget={resolvedWorkflow.typeId.toString()}
        toolbar={toolbar}
        extraSideTabs={[runsTab]}
        activeSideTab={activeSideTab}
        onActiveSideTabChange={setActiveSideTab}
        showLearningMode={showLearningMode}
        learningPanel={learningPanel}
        onDelete={async () => {
          await resolvedWorkflow.delete();
          navigation.openDock(DockPointer.forAssetList(Workflow.type));
        }}
        deleteLabel={resolvedWorkflow.name ?? undefined}
      />

      <AlertDialog open={showMcpModal} onOpenChange={setShowMcpModal}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Flow MCP not enabled</AlertDialogTitle>
            <AlertDialogDescription>
              The <code>flow-sdk-mcp</code> server is required to run workflows with progress
              tracing. Enable it to continue.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button disabled={mcpEnabling} onClick={() => void handleEnableMcp('project')}>
              Enable for project
            </Button>
            <Button disabled={mcpEnabling} onClick={() => void handleEnableMcp('user')}>
              Enable for user
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
