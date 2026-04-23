import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import { WorkflowAssetEditor } from '@src/components/assets/editor/workflow/WorkflowAssetEditor';
import { ConfirmDialog } from '@src/components/ui/confirm-dialog';
import { InputDialog } from '@src/components/ui/input-dialog';
import { Button } from '@src/components/ui/button';
import { ScrollArea } from '@src/components/ui/scroll-area';
import { useToast } from '@src/hooks/use-toast';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { FSRef, QueryRequest, Workflow } from '@sdk';
import { openExternalFromComputeNode } from '@sdk/entities/compute-node';
import {
  ExternalLink,
  FilePlus,
  Loader2,
  Trash2,
  Workflow as WorkflowIcon,
} from 'lucide-react';
import { useCallback, useMemo, useRef, useState, KeyboardEvent } from 'react';

/**
 * Workflows sidebar view. Owns the left list (create / rename / delete) and
 * delegates the actual workflow editing surface to `WorkflowAssetEditor` —
 * the same component the wiki mounts when you open a workflow `.md` from the
 * asset tree. One editor, two mount points.
 */
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

  const selectedFsRef = useMemo(() => {
    if (!selectedWorkflow?.source_vfs_path || !fsTypeId) return null;
    const path = selectedWorkflow.source_vfs_path.replace(/^\//, '');
    return new FSRef(path, fsTypeId);
  }, [selectedWorkflow?.source_vfs_path, fsTypeId]);

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

      {/* Right panel: editor — same component the wiki uses */}
      <div className="flex min-w-0 flex-1 flex-col">
        {selectedWorkflow && selectedFsRef ? (
          <WorkflowAssetEditor
            key={selectedWorkflow.id}
            fsRef={selectedFsRef}
            workflow={selectedWorkflow}
          />
        ) : selectedWorkflow ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            No file linked to this workflow.
          </div>
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
