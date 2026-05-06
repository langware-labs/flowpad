import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
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
}: ProjectSelectorModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="h-80">
          <ProjectSelector
            projects={projects}
            selectedId={selectedId}
            isLoading={isLoading}
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
