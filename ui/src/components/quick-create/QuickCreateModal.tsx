import { Trans, useLingui } from '@lingui/react/macro';
import { ContextEntitiesEnum, dataContext } from '@sdk';
import { useProject } from '@sdk/react/hooks';
import { ProjectSelectorModal } from '@src/components/project-selector';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { useProjects } from '@src/hooks/use-projects';
import { FolderOpen } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { projectRecencyMs } from '@src/lib/project-recency';
import { QuickCreatePanel, type PanelHandlers } from './QuickCreatePanel';

interface QuickCreateModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The tiles' handlers, straight from `useQuickCreatePick` — this dialog only
   *  forwards them; the panel is what uses them. */
  panelProps: PanelHandlers;
}

/**
 * QuickCreateModal — the desktop "+" tile's launcher: {@link QuickCreatePanel}'s
 * tiles in a dialog, under a project chip that retargets what gets created.
 *
 * The tiles themselves live in the panel, which ProjectHome renders directly on
 * the page — this component is only the dialog around them.
 */
export function QuickCreateModal({ open, onOpenChange, panelProps }: QuickCreateModalProps) {
  const { t } = useLingui();
  const { project: currentProject } = useProject();
  const { projects, isLoading: isLoadingProjects } = useProjects();
  const [projectModalOpen, setProjectModalOpen] = useState(false);

  const projectItems = useMemo(
    () =>
      (projects ?? []).map((p) => ({
        id: p.id,
        name: p.displayName,
        path: p.fs_storage_mount_path ?? '',
        modifiedAt: p.updated_date ?? null,
        recencyMs: projectRecencyMs({ last_active_at: p.last_active_at, modified_at: p.updated_date }),
      })),
    [projects],
  );

  const handleProjectSelect = useCallback(
    async (id: string) => {
      const picked = projects?.find((p) => p.id === id);
      if (!picked) return;
      await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentProjectTypeId, picked.typeId);
      await dataContext.refreshProject();
      dataContext.setWorkdir(picked.fs_storage_mount_path ?? null);
    },
    [projects],
  );

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              <Trans>Create new</Trans>
            </DialogTitle>
            <DialogDescription>
              <button
                type="button"
                onClick={() => {
                  onOpenChange(false);
                  setProjectModalOpen(true);
                }}
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-transparent px-2 py-1 text-xs transition-colors hover:bg-accent"
                title={t`Switch project`}
              >
                <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="shrink-0 rounded-full bg-muted px-1.5 py-px text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  <Trans>Project</Trans>
                </span>
                <span className="max-w-[160px] truncate">{currentProject?.displayName ?? t`Select…`}</span>
              </button>
            </DialogDescription>
          </DialogHeader>

          <QuickCreatePanel {...panelProps} onDone={() => onOpenChange(false)} />
        </DialogContent>
      </Dialog>

      <ProjectSelectorModal
        open={projectModalOpen}
        onOpenChange={setProjectModalOpen}
        projects={projectItems}
        selectedId={currentProject?.id ?? null}
        onSelect={(id) => void handleProjectSelect(id)}
        isLoading={isLoadingProjects}
      />
    </>
  );
}
