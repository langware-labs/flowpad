import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Plus } from 'lucide-react';
import { ProjectSelector, type ProjectSelectorItem } from './ProjectSelector';

export interface ProjectSelectorModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: ProjectSelectorItem[];
  selectedId: string | null;
  /** Called with the picked id. The modal closes automatically on selection. */
  onSelect: (id: string) => void;
  isLoading?: boolean;
  title?: string;
  /** When provided, renders a small "+" button next to the title. */
  onCreateNew?: () => void;
  /** Ids to hide from the list — see `ProjectSelectorProps.excludeIds`. */
  excludeIds?: ReadonlyArray<string>;
}

/**
 * Simple modal wrapper around `ProjectSelector` — just the list inside a Dialog.
 * Picking a project closes the modal.
 */
export function ProjectSelectorModal({
  open,
  onOpenChange,
  projects,
  selectedId,
  onSelect,
  isLoading,
  title = 'Select project',
  onCreateNew,
  excludeIds,
}: ProjectSelectorModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center justify-between gap-2 pr-8">
            <DialogTitle>{title}</DialogTitle>
            {onCreateNew && (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={onCreateNew}
                title="New project"
                type="button"
              >
                <Plus className="h-4 w-4" />
              </Button>
            )}
          </div>
        </DialogHeader>
        <div className="h-80 min-w-0 overflow-hidden">
          <ProjectSelector
            projects={projects}
            selectedId={selectedId}
            isLoading={isLoading}
            excludeIds={excludeIds}
            onSelect={(id) => {
              if (!id) return;
              onSelect(id);
              onOpenChange(false);
            }}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default ProjectSelectorModal;
