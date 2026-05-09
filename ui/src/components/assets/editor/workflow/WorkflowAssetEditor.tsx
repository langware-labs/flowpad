import { MarkdownEditor } from '@src/components/assets/editor/markdown/MarkdownEditor';
import { enableMcp, isMcpAvailable } from '@src/components/assets/utils';
import type { ExtraSideTab } from '@src/components/milkdown-editor/EditorWithSidePanel';
import { WorkflowRunsPanel } from '@src/components/workflows-view/WorkflowRunsPanel';
import { WorkflowTraceViewer } from '@src/components/workflow-trace';
import {
  workflowRunStore,
  type ProcessEntry,
} from '@src/components/workflows-view/workflow-run-store';
import { useProcessesForTarget } from '@src/components/entity-execution-panel';
import { RunButton } from '@src/components/assets/editor/run/RunButton';
import { Button } from '@src/components/ui/button';
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
  // Phase 3 (greedy v1): viewer renders whatever trace/analysis files are
  // present in the run's output_folder.
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

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

  const doRun = useCallback(async () => {
    if (!resolvedWorkflow?.asset_ref) return;
    const systemSkills = dataContext.bootstrapInfo?.desktop_info?.paths?.system_skills;
    const flowSkillPath = systemSkills
      ? `/${systemSkills}/flow/SKILL.md`
      : '~/.flow/system_assets/skills/flow/SKILL.md';
    const instruction = `Run workflow at /${resolvedWorkflow.asset_ref} using the flow skill located at: ${flowSkillPath}`;
    const workdir = dataContext.project?.fs_storage_mount_path;

    const cliOptions = new ClaudeCliOptions({
      permission_mode: 'bypassPermissions',
      print_mode: true,
      output_format: 'stream-json',
      verbose: true,
    });
    const process = await new AgenticProcess({
      cli_config: cliOptions.toJson(),
      context_data: { project_id: dataContext.project?.id },
      workdir,
      visible: false,
      target_vfs_path: resolvedWorkflow.typeId.toString(),
      process_type: ProcessType.Execution,
    }).save([resolvedWorkflow.typeId]);

    void process.prompt(instruction);
    setProcessEntry({ process });
    setActiveSideTab('runs');
  }, [resolvedWorkflow]);

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

  return (
    <>
      {selectedRunId ? (
        <WorkflowTraceViewer
          processId={selectedRunId}
          onBack={() => setSelectedRunId(null)}
        />
      ) : (
        <MarkdownEditor
          fsRef={resolvedWorkflow.doc ?? fsRef}
          chatTarget={resolvedWorkflow.typeId.toString()}
          toolbar={toolbar}
          extraSideTabs={[runsTab]}
          activeSideTab={activeSideTab}
          onActiveSideTabChange={setActiveSideTab}
        />
      )}

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
