import { Button } from '@src/components/ui/button';
import { ScrollArea } from '@src/components/ui/scroll-area';
import { useToast } from '@src/hooks/use-toast';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { QueryRequest, Workflow } from '@sdk';
import { FilePlus, Play, Trash2, Workflow as WorkflowIcon } from 'lucide-react';
import { useMemo, useCallback, useState } from 'react';
import { InputDialog } from '@src/components/ui/input-dialog';
import { ConfirmDialog } from '@src/components/ui/confirm-dialog';
import { workflowRunStore } from './workflow-run-store';

export function WorkflowStrip() {
  const { navigation } = useDockNavigation();
  const { toast } = useToast();
  const [newDialogOpen, setNewDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Workflow | null>(null);

  const request = useMemo(() => new QueryRequest({ type: Workflow.type }), []);
  const { data: workflows = [], refetch } = useEntitiesQuery<Workflow>(request);

  const handleClick = useCallback(
    (workflow: Workflow) => {
      navigation.openDock(workflow.dockPointer);
    },
    [navigation],
  );

  const handleRun = useCallback(
    async (workflow: Workflow, e: React.MouseEvent) => {
      e.stopPropagation();
      console.log('[WorkflowStrip] handleRun fired for', workflow.id, workflow.displayName);
      try {
        const entry = await workflow.run();
        console.log('[WorkflowStrip] run() succeeded, shellId:', entry.shellId);
        workflowRunStore.set(workflow.id, entry);
        navigation.openDock(workflow.dockPointer);
      } catch (err) {
        console.error('[WorkflowStrip] Failed to run workflow:', err);
        toast({ title: 'Failed to run workflow', variant: 'destructive' });
      }
    },
    [navigation, toast],
  );

  const handleDelete = useCallback(
    async (workflow: Workflow) => {
      try {
        await workflow.delete();
        await refetch();
        toast({ title: 'Workflow deleted' });
      } catch (err) {
        console.error('[WorkflowStrip] Failed to delete workflow:', err);
        toast({ title: 'Failed to delete workflow', variant: 'destructive' });
      }
    },
    [refetch, toast],
  );

  const handleNewWorkflow = useCallback(
    async (name: string) => {
      if (!name.trim()) return;
      try {
        const saved = await Workflow.create(name);
        await refetch();
        navigation.openDock(saved.dockPointer);
        toast({ title: 'Workflow created' });
      } catch (err) {
        console.error('[WorkflowStrip] Failed to create workflow:', err);
        toast({ title: 'Failed to create workflow', variant: 'destructive' });
      }
    },
    [navigation, refetch, toast],
  );

  return (
    <div className="flex flex-col rounded-lg border">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2">
        <div className="flex items-center gap-1.5">
          <WorkflowIcon className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs font-medium">Workflows</span>
          {workflows.length > 0 && (
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
              {workflows.length}
            </span>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5"
          title="New Workflow"
          onClick={() => setNewDialogOpen(true)}
        >
          <FilePlus className="h-3 w-3" />
        </Button>
      </div>

      {/* List */}
      <ScrollArea className="max-h-[140px]">
        {workflows.length === 0 ? (
          <div className="px-3 pb-3 text-xs text-muted-foreground">No workflows</div>
        ) : (
          <div className="pb-1">
            {workflows.map((workflow) => (
              <div
                key={workflow.id}
                className="group flex cursor-pointer items-center justify-between px-3 py-1 hover:bg-muted/50"
                onClick={() => handleClick(workflow)}
              >
                <span className="truncate text-xs">{workflow.displayName}</span>
                <div className="flex flex-shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-5 w-5"
                    title="Run workflow"
                    onClick={(e) => void handleRun(workflow, e)}
                  >
                    <Play className="h-3 w-3" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-5 w-5 text-destructive hover:text-destructive"
                    title="Delete"
                    onClick={(e) => { e.stopPropagation(); setDeleteTarget(workflow); }}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </ScrollArea>

      <InputDialog
        open={newDialogOpen}
        onOpenChange={setNewDialogOpen}
        title="New Workflow"
        placeholder="Workflow name"
        confirmLabel="Create"
        onConfirm={(name) => void handleNewWorkflow(name)}
      />
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title="Delete Workflow"
        description={`Are you sure you want to delete "${deleteTarget?.displayName}"?`}
        confirmLabel="Delete"
        onConfirm={() => { if (deleteTarget) void handleDelete(deleteTarget); }}
      />
    </div>
  );
}
