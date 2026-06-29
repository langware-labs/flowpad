import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import { NavigatorPanel } from '@src/components/navigator-panel/NavigatorPanel';
import type { NavigatorDescriptor } from '@src/components/navigator-panel/types';
import { flatEntityRoots } from '@src/components/browseable-tree/adapters/flatEntityRoot';
import { ConfirmDialog } from '@src/components/ui/confirm-dialog';
import { InputDialog } from '@src/components/ui/input-dialog';
import { notify } from '@src/notifications';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { QueryRequest, Workflow } from '@sdk';
import { openExternalFromComputeNode } from '@sdk/entities/compute-node';
import { ExternalLink, FilePlus, Trash2, Workflow as WorkflowIcon } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

/**
 * Workflows left-menu — the navigator (Zone B). Owns the list, create/rename/
 * delete; the editor body is `WorkflowsPage`. Selection is URL-first via
 * `DockPointer.forWorkflows(id)`.
 */
export function WorkflowsNavigator() {
  const { computeNode } = useAgentContext();
  const { navigation, currentDock } = useDockNavigation();
  const fsTypeId = computeNode?.typeId;

  const request = useMemo(() => new QueryRequest({ type: Workflow.type }), []);
  const { data: workflows = [], isLoading, refetch } = useEntitiesQuery<Workflow>(request);

  const selectedId = currentDock?.pointer;
  const [newDialogOpen, setNewDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Workflow | null>(null);

  const handleNewWorkflow = useCallback(
    async (name: string) => {
      if (!name.trim()) return;
      try {
        const saved = await Workflow.create(name);
        await refetch();
        navigation.openDock(DockPointer.forWorkflows(saved.id));
        notify.success({ title: 'Workflow created' });
      } catch (err) {
        console.error('[WorkflowsNavigator] Failed to create workflow:', err);
        notify.error({ title: 'Failed to create workflow' });
      }
    },
    [navigation, refetch],
  );

  const handleDeleteWorkflow = useCallback(
    async (workflow: Workflow) => {
      try {
        await workflow.delete();
        await refetch();
        if (selectedId === workflow.id) navigation.openDock(DockPointer.forWorkflows());
        notify.success({ title: 'Workflow deleted' });
      } catch (err) {
        console.error('[WorkflowsNavigator] Failed to delete workflow:', err);
        notify.error({ title: 'Failed to delete workflow' });
      }
    },
    [navigation, refetch, selectedId],
  );

  const handleOpenExternal = useCallback(
    async (workflow: Workflow) => {
      if (!workflow.asset_ref || !fsTypeId?.id) {
        notify.error({ title: 'No file linked to this workflow' });
        return;
      }
      try {
        await openExternalFromComputeNode(fsTypeId.id, workflow.asset_ref);
      } catch (err) {
        console.error('[WorkflowsNavigator] Open external failed:', err);
        notify.error({ title: 'Failed to open file' });
      }
    },
    [fsTypeId],
  );

  const handleRenameWorkflow = useCallback(
    async (workflow: Workflow, newName: string) => {
      try {
        await workflow.rename(newName);
        await refetch();
      } catch (err) {
        console.error('[WorkflowsNavigator] Rename failed:', err);
        notify.error({ title: 'Failed to rename workflow' });
      }
    },
    [refetch],
  );

  const roots = useMemo(
    () =>
      flatEntityRoots(
        workflows.map((w) => ({
          id: w.id,
          label: w.displayName,
          pointer: DockPointer.forWorkflows(w.id),
          icon: <WorkflowIcon className="h-3.5 w-3.5 text-muted-foreground" />,
          onRename: (newName: string) => void handleRenameWorkflow(w, newName),
          toolbar: [
            {
              id: 'open-external',
              icon: <ExternalLink />,
              label: 'Open in external editor',
              run: () => void handleOpenExternal(w),
            },
            {
              id: 'delete',
              icon: <Trash2 className="text-destructive" />,
              label: 'Delete workflow',
              run: () => setDeleteTarget(w),
            },
          ],
        })),
      ),
    [workflows, handleRenameWorkflow, handleOpenExternal],
  );

  const descriptor: NavigatorDescriptor = useMemo(
    () => ({
      id: 'workflows',
      roots,
      isLoading,
      header: {
        title: 'Workflows',
        countBadge: workflows.length,
        toolbar: [
          {
            id: 'new',
            icon: <FilePlus />,
            label: 'New Workflow',
            run: () => setNewDialogOpen(true),
            showBusyIndicator: false,
          },
        ],
      },
      activePointer: currentDock ?? null,
      onNavigate: (p) => navigation.openDock(p),
    }),
    [roots, isLoading, workflows.length, currentDock, navigation],
  );

  return (
    <>
      <NavigatorPanel descriptor={descriptor} />
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
    </>
  );
}
