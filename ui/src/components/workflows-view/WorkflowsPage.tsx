import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import { MilkdownEditor } from '@src/components/milkdown-editor/MilkdownEditor';
import { InteractiveTerminal } from '@src/components/terminal';
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@src/components/ui/alert-dialog';
import { ConfirmDialog } from '@src/components/ui/confirm-dialog';
import { InputDialog } from '@src/components/ui/input-dialog';
import { Button } from '@src/components/ui/button';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@src/components/ui/resizable';
import { ScrollArea } from '@src/components/ui/scroll-area';
import { useToast } from '@src/hooks/use-toast';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { useProcessState } from '@src/hooks/use-process-state';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { ActionInfo, AgenticProcess, dataContext, dataManager, fsManager, ProcessorStatus, QueryRequest, type TypeId, Workflow } from '@sdk';
import { ComputeNode, openExternalFromComputeNode } from '@sdk/entities/compute-node';
import { ExternalLink, FilePlus, Loader2, Play, Save, Trash2, Workflow as WorkflowIcon, Zap } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState, KeyboardEvent } from 'react';
import { WorkflowTraceGutter } from './WorkflowTraceGutter';
import type { ClaudeTraceEvent } from '@src/types/trace-event';
import { useClaudeSessionTrace } from '@src/hooks/use-claude-session-trace';

async function isMcpAvailable(serverName: string): Promise<boolean> {
  try {
    const actionInfo = new ActionInfo('mcp-available', 'compute_node', '@local', 'GET');
    actionInfo.queryParameters = { server: serverName };
    const result = await dataManager.callAction<null, { available: boolean }>(actionInfo);
    return (result as { available: boolean })?.available ?? false;
  } catch {
    return false;
  }
}

async function enableMcp(serverName: string, scope: 'user' | 'project'): Promise<void> {
  const actionInfo = new ActionInfo('mcp-enable', 'compute_node', '@local', 'POST');
  actionInfo.bodyParameters = { server: serverName, scope };
  await dataManager.callAction(actionInfo);
}

import { workflowRunStore, type ProcessEntry } from './workflow-run-store';

/** Load and edit the markdown file linked to a workflow entity */
function WorkflowEditor({
  workflow,
  fsTypeId,
  processEntry,
  onProcessChange,
  prepareEntry,
  onPrepareChange,
}: {
  workflow: Workflow;
  fsTypeId: TypeId | undefined;
  processEntry: ProcessEntry | null;
  onProcessChange: (entry: ProcessEntry | null) => void;
  prepareEntry: ProcessEntry | null;
  onPrepareChange: (entry: ProcessEntry | null) => void;
}) {
  const { toast } = useToast();
  const [content, setContent] = useState('');
  const [isDirty, setIsDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [isPreparing, setIsPreparing] = useState(false);
  const [showMcpModal, setShowMcpModal] = useState(false);
  const [mcpEnabling, setMcpEnabling] = useState(false);
  // 'source' | 'prepared' — which file to show in the editor
  const [viewMode, setViewMode] = useState<'source' | 'prepared'>('source');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Annotation state
  const [workerSessionId, setWorkerSessionId] = useState<string | null>(null);
  const [traceHistory, setTraceHistory] = useState<{ sessionId: string; events: ClaudeTraceEvent[] }[]>([]);
  const [selectedHistoryIdx, setSelectedHistoryIdx] = useState<number | null>(null);
  const editorContainerRef = useRef<HTMLDivElement>(null);
  const prevSessionIdRef = useRef<string | null>(null);
  const prevEventsRef = useRef<ClaudeTraceEvent[]>([]);

  // Collect live workflow_trace events for the current worker session
  const { events: allSessionEvents } = useClaudeSessionTrace(workerSessionId);
  const currentTraceEvents = useMemo(
    () => allSessionEvents.filter(
      (e) => e.webhook_type === 'hook_op' && e.hook_data?.event_name === 'workflow_trace',
    ),
    [allSessionEvents],
  );

  // When the session ID changes (new run), save previous run's events to history
  useEffect(() => {
    if (workerSessionId !== prevSessionIdRef.current) {
      const prev = prevEventsRef.current;
      if (prevSessionIdRef.current && prev.length > 0) {
        setTraceHistory((h) => [...h, { sessionId: prevSessionIdRef.current!, events: prev }]);
      }
      prevSessionIdRef.current = workerSessionId;
      setSelectedHistoryIdx(null);
    }
    prevEventsRef.current = currentTraceEvents;
  }, [workerSessionId, currentTraceEvents]);

  const { state: processState } = useProcessState(processEntry?.process ?? null);
  const { state: prepareState } = useProcessState(prepareEntry?.process ?? null);
  const ACTIVE_STATUSES = new Set([
    ProcessorStatus.IDLE,
    ProcessorStatus.INITIALIZING,
    ProcessorStatus.RUNNING,
    ProcessorStatus.WAITING_FOR_INPUT,
  ]);
  const isRunning = !!processEntry && ACTIVE_STATUSES.has(processState.status);
  const isPrepareRunning = !!prepareEntry && ACTIVE_STATUSES.has(prepareState.status);

  // When the prepare process finishes, verify the file actually landed on disk.
  // If it didn't, `verifyPrepared` clears prepared_vfs_path and saves the entity.
  const prevPrepareRunningRef = useRef(false);
  useEffect(() => {
    if (prevPrepareRunningRef.current && !isPrepareRunning && prepareEntry && fsTypeId) {
      void workflow.verifyPrepared(fsTypeId).then((ok) => {
        if (!ok) toast({ title: 'Prepare did not produce a file — please try again.', variant: 'destructive' });
      });
    }
    prevPrepareRunningRef.current = isPrepareRunning;
  }, [isPrepareRunning, prepareEntry, fsTypeId, workflow, toast]);

  // Which file path is shown in the editor
  const sourcePath = workflow.source_vfs_path;
  const hasPrepared = workflow.isPrepared;
  const path = viewMode === 'prepared' && hasPrepared ? workflow.preparedPath! : sourcePath;

  // Reset to source view when the workflow changes
  useEffect(() => {
    setViewMode('source');
  }, [workflow.id]);

  useEffect(() => {
    if (!path || !fsTypeId) return;
    setIsLoading(true);
    setIsDirty(false);
    void fsManager
      .download(fsTypeId, path)
      .then((text) => {
        setContent(typeof text === 'string' ? text : '');
      })
      .catch((err) => {
        console.error('[WorkflowEditor] Failed to load file:', err);
        toast({ title: 'Failed to load workflow file', variant: 'destructive' });
      })
      .finally(() => setIsLoading(false));
  }, [path, fsTypeId, toast]);

  const handleChange = useCallback(
    (value: string) => {
      setContent(value);
      setIsDirty(true);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        if (!path || !fsTypeId) return;
        void fsManager
          .writeFile(fsTypeId, path, value)
          .catch((err) => console.error('[WorkflowEditor] Auto-save failed:', err));
      }, 1000);
    },
    [path, fsTypeId],
  );

  const handleSave = useCallback(async () => {
    if (!path || !fsTypeId || !isDirty) return;
    setIsSaving(true);
    try {
      await fsManager.writeFile(fsTypeId, path, content);
      setIsDirty(false);
    } catch (err) {
      console.error('[WorkflowEditor] Save failed:', err);
      toast({ title: 'Save failed', variant: 'destructive' });
    } finally {
      setIsSaving(false);
    }
  }, [path, fsTypeId, isDirty, content, toast]);

  const handleOpenExternal = useCallback(async () => {
    if (!path || !fsTypeId?.id) {
      toast({ title: 'No file linked to this workflow', variant: 'destructive' });
      return;
    }
    try {
      await openExternalFromComputeNode(fsTypeId.id, path);
    } catch (err) {
      console.error('[WorkflowEditor] Open external failed:', err);
      toast({ title: 'Failed to open file', variant: 'destructive' });
    }
  }, [path, fsTypeId, toast]);

  const doRun = useCallback(async () => {
    const systemSkills = dataContext.bootstrapInfo?.desktop_info?.paths?.system_skills;
    const flowSkillPath = systemSkills ? `/${systemSkills}/flow/SKILL.md` : '~/.flow/system_assets/skills/flow/SKILL.md';
    const runPath = workflow.preparedPath ?? workflow.source_vfs_path;
    const instruction = `Run workflow at /${runPath} using the flow skill located at: ${flowSkillPath}`;
    const workdir = dataContext.project?.fs_storage_mount_path;
    const { process, shellId } = await AgenticProcess.spawn(
      { permissionMode: 'bypassPermissions', workdir },
      { instruction },
    );
    onProcessChange({ process, shellId: shellId! });
  }, [workflow, onProcessChange]);

  const doPrepare = useCallback(async () => {
    const systemSkills = dataContext.bootstrapInfo?.desktop_info?.paths?.system_skills;
    const compileSkillPath = systemSkills
      ? `/${systemSkills}/compile-workflow/SKILL.md`
      : '~/.flow/system_assets/skills/compile-workflow/SKILL.md';
    const derived = Workflow.derivePreparedPath(workflow.source_vfs_path!);
    const instruction = `Prepare workflow at /${workflow.source_vfs_path}, write prepared steps to /${derived}, using the compile-workflow skill at: ${compileSkillPath}`;
    const workdir = dataContext.project?.fs_storage_mount_path;
    const { process, shellId } = await AgenticProcess.spawn(
      { permissionMode: 'bypassPermissions', workdir },
      { instruction },
    );
    // Optimistically persist the prepared path on the entity
    workflow.prepared_vfs_path = derived;
    await workflow.save();
    onPrepareChange({ process, shellId: shellId! });
  }, [workflow, onPrepareChange]);

  const handlePrepare = useCallback(async () => {
    if (!workflow.source_vfs_path) return;
    setIsPreparing(true);
    try {
      const available = await isMcpAvailable('flow-sdk-mcp');
      if (!available) {
        setShowMcpModal(true);
        return;
      }
      await doPrepare();
    } catch (err) {
      console.error('[WorkflowEditor] Failed to prepare workflow:', err);
      toast({ title: 'Failed to prepare workflow', variant: 'destructive' });
    } finally {
      setIsPreparing(false);
    }
  }, [workflow, doPrepare, toast]);

  const handleRun = useCallback(async () => {
    if (!workflow.source_vfs_path) return;
    setIsStarting(true);
    try {
      const available = await isMcpAvailable('flow-sdk-mcp');
      if (!available) {
        setShowMcpModal(true);
        return;
      }
      await doRun();
    } catch (err) {
      console.error('[WorkflowEditor] Failed to start workflow:', err);
      toast({ title: 'Failed to start workflow', variant: 'destructive' });
    } finally {
      setIsStarting(false);
    }
  }, [workflow, doRun, toast]);

  const handleEnableMcp = useCallback(async (scope: 'user' | 'project') => {
    setMcpEnabling(true);
    try {
      await enableMcp('flow-sdk-mcp', scope);
      setShowMcpModal(false);
      toast({ title: `flow-sdk-mcp enabled (${scope} scope). Starting workflow…` });
      await doRun();
    } catch (err) {
      console.error('[WorkflowEditor] Failed to enable MCP:', err);
      toast({ title: 'Failed to enable MCP', variant: 'destructive' });
    } finally {
      setMcpEnabling(false);
    }
  }, [doRun, toast]);

  const handleClose = useCallback(async () => {
    const entry = processEntry ?? prepareEntry;
    if (entry) {
      try {
        await entry.process.stop();
      } catch (err) {
        console.error('[WorkflowEditor] Failed to stop process:', err);
      }
    }
    onProcessChange(null);
    onPrepareChange(null);
  }, [processEntry, prepareEntry, onProcessChange, onPrepareChange]);

  if (!sourcePath) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        No file linked to this workflow.
      </div>
    );
  }

  const activeEntry = processEntry ?? prepareEntry;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      {/* Action bar */}
      <div className="flex h-[52px] flex-shrink-0 items-center justify-between border-b bg-muted/50 px-3">
        <h3 className="truncate text-sm font-medium">{workflow.displayName}</h3>
        <div className="flex items-center gap-2">
          {isDirty && (
            <Button size="sm" onClick={() => void handleSave()} disabled={isSaving}>
              <Save className={`mr-1 h-4 w-4 ${isSaving ? 'animate-pulse' : ''}`} />
              {isSaving ? 'Saving...' : 'Save'}
            </Button>
          )}
          {workflow.isPrepared && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setViewMode((m) => (m === 'prepared' ? 'source' : 'prepared'))}
              title={viewMode === 'prepared' ? 'Switch to source view' : 'Switch to prepared view'}
            >
              {viewMode === 'prepared' ? 'Source' : 'Prepared'}
            </Button>
          )}
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void handlePrepare()}
            disabled={isPreparing || isRunning || isStarting || !workflow.source_vfs_path}
            title={!workflow.source_vfs_path ? 'No file linked' : isPrepareRunning ? 'Preparing…' : 'Prepare workflow'}
          >
            {isPreparing || isPrepareRunning ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <Zap className="mr-1 h-4 w-4" />
            )}
            {isPreparing || isPrepareRunning ? 'Preparing…' : 'Prepare'}
          </Button>
          <Button
            size="sm"
            onClick={() => void handleRun()}
            disabled={isRunning || isStarting || isPreparing || !workflow.source_vfs_path}
            title={!workflow.source_vfs_path ? 'No file linked' : isRunning ? 'Workflow running…' : 'Run workflow'}
          >
            {isRunning || isStarting ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <Play className="mr-1 h-4 w-4" />
            )}
            {isRunning ? 'Running…' : isStarting ? 'Starting…' : 'Run'}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void handleOpenExternal()} title="Open in external editor">
            <ExternalLink className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Editor */}
      {isLoading ? (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : activeEntry ? (
        <ResizablePanelGroup direction="vertical" className="min-h-0 flex-1">
          <ResizablePanel defaultSize={70} minSize={20}>
            <div className="flex h-full overflow-hidden">
              <div className="min-w-0 flex-1 overflow-auto" ref={editorContainerRef}>
                <MilkdownEditor content={content} onChange={handleChange} />
              </div>
              {processEntry && (
                <WorkflowTraceGutter
                  workerSessionId={workerSessionId}
                  editorContainerRef={editorContainerRef as React.RefObject<HTMLDivElement>}
                  displayEvents={
                    selectedHistoryIdx !== null
                      ? (traceHistory[selectedHistoryIdx]?.events ?? [])
                      : currentTraceEvents
                  }
                  traceHistory={traceHistory}
                  selectedHistoryIdx={selectedHistoryIdx}
                  onSelectHistory={setSelectedHistoryIdx}
                />
              )}
            </div>
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={30} minSize={10}>
            <InteractiveTerminal
              sessionId={activeEntry.shellId}
              process={activeEntry.process}
              active
              embedded
              onClose={() => void handleClose()}
              onWorkerSessionId={setWorkerSessionId}
              className="h-full"
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <MilkdownEditor content={content} onChange={handleChange} />
        </div>
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
    </div>
  );
}

export function WorkflowsPage() {
  const { computeNode } = useAgentContext();
  const { navigation, currentDock } = useDockNavigation();
  const { toast } = useToast();

  const fsTypeId = computeNode?.typeId;

  const request = useMemo(() => new QueryRequest({ type: Workflow.type }), []);
  const { data: workflows = [], isLoading, refetch } = useEntitiesQuery<Workflow>(request);

  const selectedId = currentDock?.pointer;
  const selectedWorkflow = useMemo(
    () => (selectedId ? workflows.find((w) => w.id === selectedId) : null),
    [selectedId, workflows],
  );

  // Per-workflow process state — survives workflow list navigation
  const [processMap, setProcessMap] = useState<Map<string, ProcessEntry>>(new Map());
  const [prepareMap, setPrepareMap] = useState<Map<string, ProcessEntry>>(new Map());

  const setWorkflowProcess = useCallback((workflowId: string, entry: ProcessEntry | null) => {
    setProcessMap((prev) => {
      const next = new Map(prev);
      if (entry) next.set(workflowId, entry);
      else next.delete(workflowId);
      return next;
    });
  }, []);

  const setWorkflowPrepare = useCallback((workflowId: string, entry: ProcessEntry | null) => {
    setPrepareMap((prev) => {
      const next = new Map(prev);
      if (entry) next.set(workflowId, entry);
      else next.delete(workflowId);
      return next;
    });
  }, []);

  // Hydrate from module-level store (set by WorkflowStrip Play button before navigation)
  useEffect(() => {
    if (!selectedId) return;
    const entry = workflowRunStore.get(selectedId);
    console.log('[WorkflowsPage] selectedId changed:', selectedId, 'store entry:', entry ? 'found' : 'not found');
    if (entry) {
      setWorkflowProcess(selectedId, entry);
      workflowRunStore.delete(selectedId);
    }
  }, [selectedId, setWorkflowProcess]);

  const [newDialogOpen, setNewDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Workflow | null>(null);

  const handleSelectWorkflow = useCallback(
    (workflow: Workflow) => {
      navigation.openDock(DockPointer.forWorkflows(workflow.id));
    },
    [navigation],
  );

  const handleNewWorkflow = useCallback(
    async (name: string) => {
      if (!name.trim()) return;
      try {
        const saved = await Workflow.create(name);
        await refetch();
        navigation.openDock(DockPointer.forWorkflows(saved.id));
        toast({ title: 'Workflow created' });
      } catch (err) {
        console.error('[WorkflowsPage] Failed to create workflow:', err);
        toast({ title: 'Failed to create workflow', variant: 'destructive' });
      }
    },
    [navigation, refetch, toast],
  );

  const handleDeleteWorkflow = useCallback(
    async (workflow: Workflow) => {
      try {
        await workflow.delete();
        await refetch();
        setProcessMap((prev) => {
          const next = new Map(prev);
          next.delete(workflow.id);
          return next;
        });
        if (selectedId === workflow.id) {
          navigation.openDock(DockPointer.forWorkflows());
        }
        toast({ title: 'Workflow deleted' });
      } catch (err) {
        console.error('[WorkflowsPage] Failed to delete workflow:', err);
        toast({ title: 'Failed to delete workflow', variant: 'destructive' });
      }
    },
    [navigation, refetch, selectedId, toast],
  );

  const handleOpenExternal = useCallback(
    async (workflow: Workflow) => {
      if (!workflow.source_vfs_path || !fsTypeId?.id) {
        toast({ title: 'No file linked to this workflow', variant: 'destructive' });
        return;
      }
      try {
        await openExternalFromComputeNode(fsTypeId.id, workflow.source_vfs_path);
      } catch (err) {
        console.error('[WorkflowsPage] Open external failed:', err);
        toast({ title: 'Failed to open file', variant: 'destructive' });
      }
    },
    [fsTypeId, toast],
  );

  const handleRenameWorkflow = useCallback(
    async (workflow: Workflow, newName: string) => {
      try {
        await workflow.rename(newName);
        await refetch();
      } catch (err) {
        console.error('[WorkflowsPage] Rename failed:', err);
        toast({ title: 'Failed to rename workflow', variant: 'destructive' });
      }
    },
    [refetch, toast],
  );

  return (
    <div className="flex h-full">
      {/* Left panel: workflow list */}
      <div className="flex w-64 flex-shrink-0 flex-col border-r">
        <div className="flex h-[52px] flex-shrink-0 items-center justify-between border-b px-3">
          <div className="flex items-center gap-2">
            <WorkflowIcon className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">Workflows</span>
            {workflows.length > 0 && (
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                {workflows.length}
              </span>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            title="New Workflow"
            onClick={() => setNewDialogOpen(true)}
          >
            <FilePlus className="h-4 w-4" />
          </Button>
        </div>

        <ScrollArea className="flex-1">
          {isLoading ? (
            <div className="flex h-20 items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : workflows.length === 0 ? (
            <div className="p-4 text-center text-sm text-muted-foreground">No workflows yet</div>
          ) : (
            <div className="py-1">
              {workflows.map((workflow) => (
                <WorkflowRow
                  key={workflow.id}
                  workflow={workflow}
                  isSelected={workflow.id === selectedId}
                  onClick={() => handleSelectWorkflow(workflow)}
                  onDelete={() => setDeleteTarget(workflow)}
                  onOpenExternal={() => void handleOpenExternal(workflow)}
                  onRename={(newName) => void handleRenameWorkflow(workflow, newName)}
                />
              ))}
            </div>
          )}
        </ScrollArea>
      </div>

      {/* Right panel: editor */}
      <div className="flex min-w-0 flex-1 flex-col">
        {selectedWorkflow ? (
          <WorkflowEditor
            key={selectedWorkflow.id}
            workflow={selectedWorkflow}
            fsTypeId={fsTypeId}
            processEntry={processMap.get(selectedWorkflow.id) ?? null}
            onProcessChange={(entry) => setWorkflowProcess(selectedWorkflow.id, entry)}
            prepareEntry={prepareMap.get(selectedWorkflow.id) ?? null}
            onPrepareChange={(entry) => setWorkflowPrepare(selectedWorkflow.id, entry)}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            Select a workflow to edit
          </div>
        )}
      </div>

      <InputDialog
        open={newDialogOpen}
        onOpenChange={setNewDialogOpen}
        title="New Workflow"
        description="Enter a name for the new workflow."
        placeholder="Workflow name"
        confirmLabel="Create"
        onConfirm={(name) => void handleNewWorkflow(name)}
      />
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title="Delete Workflow"
        description={`Are you sure you want to delete "${deleteTarget?.displayName}"?`}
        confirmLabel="Delete"
        onConfirm={() => {
          if (deleteTarget) void handleDeleteWorkflow(deleteTarget);
        }}
      />
    </div>
  );
}

function WorkflowRow({
  workflow,
  isSelected,
  onClick,
  onDelete,
  onOpenExternal,
  onRename,
}: {
  workflow: Workflow;
  isSelected: boolean;
  onClick: () => void;
  onDelete: () => void;
  onOpenExternal: () => void;
  onRename: (newName: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const startEditing = (e: React.MouseEvent) => {
    e.stopPropagation();
    setDraft(workflow.displayName);
    setEditing(true);
    setTimeout(() => inputRef.current?.select(), 0);
  };

  const commit = () => {
    setEditing(false);
    onRename(draft);
  };

  const cancel = () => {
    setEditing(false);
    setDraft(workflow.displayName);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') commit();
    else if (e.key === 'Escape') cancel();
  };

  return (
    <div
      className={`group flex cursor-pointer items-center justify-between px-3 py-2 hover:bg-muted/50 ${isSelected ? 'bg-muted' : ''}`}
      onClick={editing ? undefined : onClick}
    >
      {editing ? (
        <input
          ref={inputRef}
          className="min-w-0 flex-1 rounded border border-ring bg-background px-1 text-sm outline-none"
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={handleKeyDown}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span
          className="truncate text-sm"
          onClick={isSelected ? startEditing : undefined}
        >
          {workflow.displayName}
        </span>
      )}
      {!editing && (
        <div className="flex flex-shrink-0 items-center gap-1 opacity-0 group-hover:opacity-100">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            title="Open in external editor"
            onClick={(e) => {
              e.stopPropagation();
              onOpenExternal();
            }}
          >
            <ExternalLink className="h-3 w-3" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-destructive hover:text-destructive"
            title="Delete workflow"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      )}
    </div>
  );
}
