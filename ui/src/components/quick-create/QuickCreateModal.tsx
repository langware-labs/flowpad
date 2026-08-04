import { Trans, useLingui } from '@lingui/react/macro';
import { ContextEntitiesEnum, dataContext } from '@sdk';
import { useProject } from '@sdk/react/hooks';
import { ProjectSelectorModal } from '@src/components/project-selector';
import { projectEntitiesToSelectorItems } from '@src/components/project-selector/project-items';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { useProjects } from '@src/hooks/use-projects';
import { FolderOpen } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useIsAdvanced } from '@src/components/view-mode';
import { ALL_SECTIONS, QuickCreatePanel, type PanelHandlers } from './QuickCreatePanel';

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
  // Context folders are an Advanced concept — the section is dropped entirely
  // in Standard/Vibe rather than reserved, so the dialog closes the gap instead
  // of leaving a hole where the tiles were.
  const isAdvanced = useIsAdvanced();
  const sections = useMemo(
    () => (isAdvanced ? ALL_SECTIONS : ALL_SECTIONS.filter((s) => s !== 'folder')),
    [isAdvanced],
  );

  const projectItems = useMemo(() => projectEntitiesToSelectorItems(projects), [projects]);

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
        {/* Capped and scrollable: with four tile groups this dialog is taller
            than a ~670px window, and an uncapped DialogContent (centered by a
            -50% transform, overflow visible) simply hangs off both edges — the
            last group's tiles land outside the viewport where nothing can click
            them. grid-rows-[auto,minmax(0,1fr)] lets the header stay put while
            the panel takes the scroll. */}
        <DialogContent className="max-h-[85vh] max-w-md grid-rows-[auto,minmax(0,1fr)] overflow-hidden">
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

          <div className="min-h-0 overflow-y-auto pr-1">
            <QuickCreatePanel {...panelProps} sections={sections} onDone={() => onOpenChange(false)} />
          </div>
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
