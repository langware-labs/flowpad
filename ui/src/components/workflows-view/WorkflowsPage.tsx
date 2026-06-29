import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import { WorkflowAssetEditor } from '@src/components/assets/editor/workflow/WorkflowAssetEditor';
import { useEntity } from '@src/hooks/entity-hooks';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { FSRef, TypeId, Workflow } from '@sdk';
import { useMemo } from 'react';

/**
 * Workflows body — the editor surface for the workflow addressed by the URL
 * (`currentDock.pointer`). The list / create / rename / delete moved to
 * `WorkflowsNavigator` (the shared Zone B left menu); this is just the detail
 * pane. Same `WorkflowAssetEditor` the wiki mounts — one editor, two mounts.
 */
export function WorkflowsPage() {
  const { computeNode } = useAgentContext();
  const { currentDock } = useDockNavigation();
  const fsTypeId = computeNode?.typeId;

  const selectedId = currentDock?.pointer;
  // Body only needs the one selected workflow — the list lives in the navigator.
  const selectedTypeId = useMemo(() => {
    if (!selectedId) return null;
    try {
      return new TypeId(Workflow.type, selectedId);
    } catch {
      return null;
    }
  }, [selectedId]);
  const { data: selectedWorkflow } = useEntity<Workflow>(selectedTypeId);

  const selectedFsRef = useMemo(() => {
    if (!selectedWorkflow?.asset_ref || !fsTypeId) return null;
    const path = selectedWorkflow.asset_ref.replace(/^\//, '');
    return new FSRef(path, fsTypeId);
  }, [selectedWorkflow?.asset_ref, fsTypeId]);

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      {selectedWorkflow && selectedFsRef ? (
        <WorkflowAssetEditor key={selectedWorkflow.id} fsRef={selectedFsRef} workflow={selectedWorkflow} />
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
  );
}
