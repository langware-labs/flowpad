import { Trans, useLingui } from '@lingui/react/macro';
import { ContextEntitiesEnum, dataContext, Project } from '@sdk';
import { useProject } from '@sdk/react/hooks';
import { ProjectSelectorModal } from '@src/components/project-selector';
import { projectEntitiesToSelectorItems } from '@src/components/project-selector/project-items';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { useProjects } from '@src/hooks/use-projects';
import { FolderOpen } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { ADOPTION_SECTIONS, ALL_SECTIONS, QuickCreatePanel, type PanelHandlers, QuickCreateSection } from './QuickCreatePanel';

interface QuickCreateModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The tiles' handlers, straight from `useQuickCreatePick` — this dialog only
   *  forwards them; the panel is what uses them. */
  panelProps: PanelHandlers;
  /** Supplied projects are pinned; the default desktop picker remains switchable. */
  project?: Project | null;
  sections?: QuickCreateSection[];
  /** Adoption stays explicitly separate from creation. */
  showAddExisting?: boolean;
  allUserTypes?: boolean;
}

/**
 * QuickCreateModal — the desktop "+" tile's launcher: {@link QuickCreatePanel}'s
 * tiles in a dialog, under a project chip that retargets what gets created.
 *
 * The tiles themselves live in the panel; this component owns only the picker
 * chrome. Project Home pins its project and includes a separate adoption group.
 */
export function QuickCreateModal({
  open,
  onOpenChange,
  panelProps,
  project: explicitProject,
  sections: requestedSections = ALL_SECTIONS,
  showAddExisting = false,
  allUserTypes = false,
}: QuickCreateModalProps) {
  const { t } = useLingui();
  const { project: activeProject } = useProject();
  const currentProject = explicitProject === undefined ? activeProject : explicitProject;
  const { projects, isLoading: isLoadingProjects } = useProjects();
  const [projectModalOpen, setProjectModalOpen] = useState(false);
  // Adoption never belongs under "Create new": existing folders and help desks
  // appear only in the explicitly requested "Add existing" group below.
  const sections = useMemo(() => requestedSections.filter((s) => !ADOPTION_SECTIONS.has(s)), [requestedSections]);

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
        {/* Use available width for side-by-side groups. Keep the header fixed
            and the options scrollable when the viewport is short or narrow. */}
        <DialogContent className="max-h-[85vh] w-[calc(100vw-2rem)] max-w-5xl grid-rows-[auto,minmax(0,1fr)] overflow-hidden">
          <DialogHeader>
            <DialogTitle>
              {showAddExisting ? <Trans>New</Trans> : <Trans>Create new</Trans>}
            </DialogTitle>
            <DialogDescription>
              <button
                type="button"
                disabled={explicitProject !== undefined}
                onClick={() => {
                  onOpenChange(false);
                  setProjectModalOpen(true);
                }}
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-transparent px-2 py-1 text-xs transition-colors enabled:hover:bg-accent"
                title={explicitProject === undefined ? t`Switch project` : currentProject?.displayName}
              >
                <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="shrink-0 rounded-full bg-muted px-1.5 py-px text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  <Trans>Project</Trans>
                </span>
                <span className="max-w-[160px] truncate">{currentProject?.displayName ?? t`Select…`}</span>
              </button>
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 overflow-y-auto pe-1">
            {showAddExisting && <h2 className="mb-3 text-sm font-semibold"><Trans>Create new</Trans></h2>}
            <QuickCreatePanel className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,22.25rem),1fr))]" {...panelProps} project={explicitProject} allUserTypes={allUserTypes} sections={sections} onDone={() => onOpenChange(false)} />
            {showAddExisting && (
              <section className="mt-6 border-t border-border pt-4" aria-label={t`Add existing`}>
                <h2 className="mb-3 text-sm font-semibold"><Trans>Add existing</Trans></h2>
                <QuickCreatePanel className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,22.25rem),1fr))]" {...panelProps} project={explicitProject} sections={[...ADOPTION_SECTIONS]} onDone={() => onOpenChange(false)} />
              </section>
            )}
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
