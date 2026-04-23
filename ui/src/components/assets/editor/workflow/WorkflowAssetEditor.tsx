import { MarkdownEditor } from '@src/components/assets/editor/markdown/MarkdownEditor';
import { enableMcp, isMcpAvailable } from '@src/components/assets/utils';
import type { ExtraSideTab } from '@src/components/milkdown-editor/MilkdownEditorWithSidePanel';
import { PipelineViewer } from '@src/components/pipeline-viewer';
import { WorkflowRunsPanel } from '@src/components/workflows-view/WorkflowRunsPanel';
import {
  workflowRunStore,
  type ProcessEntry,
} from '@src/components/workflows-view/workflow-run-store';
import { useProcessesForTarget } from '@src/components/entity-chat-panel';
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
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import {
  AgenticProcess,
  FSRef,
  QueryRequest,
  Workflow,
  dataContext,
} from '@sdk';
import { ClaudeCliOptions } from '@sdk/cli_workers/claude-cli';
import { GitFork, History, Loader2, Play, Zap } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

type ViewMode = 'source' | 'prepared' | 'pipeline';

interface WorkflowAssetEditorProps {
  /** FSRef to the workflow's source markdown file. */
  fsRef: FSRef;
  /** Pre-resolved workflow entity. If omitted, resolved from `fsRef.path`. */
  workflow?: Workflow;
}

const stripLeadingSlash = (p: string | undefined | null): string =>
  p ? (p.startsWith('/') ? p.slice(1) : p) : '';

/**
 * Unified editor for workflow `.md` files. Mounted from both the wiki
 * (`AssetEditorRouter`) and the Workflows sidebar (`WorkflowsPage`) — one
 * surface, two entry points. Wraps `MarkdownEditor` and injects workflow
 * toolbar actions + a `Runs` tab into its side drawer.
 */
export function WorkflowAssetEditor({ fsRef, workflow: providedWorkflow }: WorkflowAssetEditorProps) {
  const { toast } = useToast();

  const request = useMemo(() => new QueryRequest({ type: Workflow.type }), []);
  const { data: workflows = [] } = useEntitiesQuery<Workflow>(request, {
    enabled: !providedWorkflow,
  });
  const resolvedWorkflow = useMemo(() => {
    if (providedWorkflow) return providedWorkflow;
    const key = stripLeadingSlash(fsRef.path);
    return workflows.find((w) => stripLeadingSlash(w.source_vfs_path) === key) ?? null;
  }, [providedWorkflow, workflows, fsRef.path]);

  const [viewMode, setViewMode] = useState<ViewMode>('source');
  const [activeSideTab, setActiveSideTab] = useState<string>('chat');
  const [processEntry, setProcessEntry] = useState<ProcessEntry | null>(null);
  const [isPreparing, setIsPreparing] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [isPipelinePreparing, setIsPipelinePreparing] = useState(false);
  const [showMcpModal, setShowMcpModal] = useState(false);
  const [mcpEnabling, setMcpEnabling] = useState(false);

  useEffect(() => {
    setViewMode('source');
  }, [resolvedWorkflow?.id]);

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
    if (!resolvedWorkflow) return;
    const systemSkills = dataContext.bootstrapInfo?.desktop_info?.paths?.system_skills;
    const flowSkillPath = systemSkills
      ? `/${systemSkills}/flow/SKILL.md`
      : '~/.flow/system_assets/skills/flow/SKILL.md';
    const runPath = resolvedWorkflow.preparedPath ?? resolvedWorkflow.source_vfs_path;
    const instruction = `Run workflow at /${runPath} using the flow skill located at: ${flowSkillPath}`;
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
      target_typeid_str: resolvedWorkflow.typeId.toString(),
    }).save([resolvedWorkflow.typeId]);

    void process.prompt(instruction);
    setProcessEntry({ process });
    setActiveSideTab('runs');
  }, [resolvedWorkflow]);

  const doPrepare = useCallback(async () => {
    if (!resolvedWorkflow?.source_vfs_path) return;
    const systemSkills = dataContext.bootstrapInfo?.desktop_info?.paths?.system_skills;
    const compileSkillPath = systemSkills
      ? `/${systemSkills}/compile-workflow/SKILL.md`
      : '~/.flow/system_assets/skills/compile-workflow/SKILL.md';
    const derived = Workflow.derivePreparedPath(resolvedWorkflow.source_vfs_path);
    const instruction = `Prepare workflow at /${resolvedWorkflow.source_vfs_path}, write prepared steps to /${derived}, using the compile-workflow skill at: ${compileSkillPath}`;
    const workdir = dataContext.project?.fs_storage_mount_path;
    await AgenticProcess.spawn(
      { permissionMode: 'bypassPermissions', workdir },
      { instruction },
    );
    resolvedWorkflow.prepared_vfs_path = derived;
    await resolvedWorkflow.save();
  }, [resolvedWorkflow]);

  const handlePrepare = useCallback(async () => {
    if (!resolvedWorkflow?.source_vfs_path) return;
    setIsPreparing(true);
    try {
      const available = await isMcpAvailable('flow-sdk-mcp');
      if (!available) {
        setShowMcpModal(true);
        return;
      }
      await doPrepare();
    } catch (err) {
      console.error('[WorkflowAssetEditor] Prepare failed:', err);
      toast({ title: 'Failed to prepare workflow', variant: 'destructive' });
    } finally {
      setIsPreparing(false);
    }
  }, [resolvedWorkflow, doPrepare, toast]);

  const handleGeneratePipeline = useCallback(async () => {
    if (!resolvedWorkflow?.source_vfs_path) return;
    setIsPipelinePreparing(true);
    try {
      await resolvedWorkflow.prepare();
      toast({ title: 'Pipeline generated' });
    } catch (err) {
      console.error('[WorkflowAssetEditor] Generate pipeline failed:', err);
      toast({ title: 'Failed to generate pipeline', variant: 'destructive' });
    } finally {
      setIsPipelinePreparing(false);
    }
  }, [resolvedWorkflow, toast]);

  const handleRun = useCallback(async () => {
    if (!resolvedWorkflow?.source_vfs_path) return;
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

  const currentFsRef = useMemo(() => {
    if (
      viewMode === 'prepared' &&
      resolvedWorkflow?.isPrepared &&
      resolvedWorkflow.preparedPath
    ) {
      return new FSRef(stripLeadingSlash(resolvedWorkflow.preparedPath), fsRef.typeId);
    }
    return fsRef;
  }, [viewMode, resolvedWorkflow, fsRef]);

  if (!resolvedWorkflow) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading workflow…
      </div>
    );
  }

  const isRunning = !!processEntry;

  const toolbar = (
    <>
      {(resolvedWorkflow.isPrepared || resolvedWorkflow.hasPipeline) && (
        <div className="flex items-center rounded-md border bg-background">
          <Button
            variant={viewMode === 'source' ? 'secondary' : 'ghost'}
            size="sm"
            className="h-8 rounded-r-none border-0 px-3 text-xs"
            onClick={() => setViewMode('source')}
          >
            Source
          </Button>
          {resolvedWorkflow.isPrepared && (
            <Button
              variant={viewMode === 'prepared' ? 'secondary' : 'ghost'}
              size="sm"
              className="h-8 rounded-none border-x px-3 text-xs"
              onClick={() => setViewMode('prepared')}
            >
              Prepared
            </Button>
          )}
          {resolvedWorkflow.hasPipeline && (
            <Button
              variant={viewMode === 'pipeline' ? 'secondary' : 'ghost'}
              size="sm"
              className="h-8 rounded-l-none border-0 px-3 text-xs"
              onClick={() => setViewMode('pipeline')}
            >
              Pipeline
            </Button>
          )}
        </div>
      )}
      <Button
        size="sm"
        variant="outline"
        onClick={() => void handleGeneratePipeline()}
        disabled={isPipelinePreparing || !resolvedWorkflow.source_vfs_path}
        title="Generate pipeline view from workflow markdown"
      >
        {isPipelinePreparing ? (
          <Loader2 className="mr-1 h-4 w-4 animate-spin" />
        ) : (
          <GitFork className="mr-1 h-4 w-4" />
        )}
        {isPipelinePreparing ? 'Generating…' : 'Pipeline'}
      </Button>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => void handlePrepare()}
        disabled={isPreparing || isRunning || isStarting || !resolvedWorkflow.source_vfs_path}
        title={!resolvedWorkflow.source_vfs_path ? 'No file linked' : 'Prepare workflow'}
      >
        {isPreparing ? (
          <Loader2 className="mr-1 h-4 w-4 animate-spin" />
        ) : (
          <Zap className="mr-1 h-4 w-4" />
        )}
        {isPreparing ? 'Preparing…' : 'Prepare'}
      </Button>
      <Button
        size="sm"
        onClick={() => void handleRun()}
        disabled={isRunning || isStarting || isPreparing || !resolvedWorkflow.source_vfs_path}
        title={
          !resolvedWorkflow.source_vfs_path
            ? 'No file linked'
            : isRunning
              ? 'Workflow running…'
              : 'Run workflow'
        }
      >
        {isRunning || isStarting ? (
          <Loader2 className="mr-1 h-4 w-4 animate-spin" />
        ) : (
          <Play className="mr-1 h-4 w-4" />
        )}
        {isRunning ? 'Running…' : isStarting ? 'Starting…' : 'Run'}
      </Button>
    </>
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
      />
    ),
  };

  return (
    <>
      {viewMode === 'pipeline' && resolvedWorkflow.hasPipeline ? (
        <PipelineViewer pipelinePath={resolvedWorkflow.pipelinePath!} fsTypeId={fsRef.typeId} />
      ) : (
        <MarkdownEditor
          fsRef={currentFsRef}
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
