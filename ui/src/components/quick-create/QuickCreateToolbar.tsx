import { type Project } from '@sdk';
import { Button } from '@src/components/ui/button';
import { FolderOpen } from 'lucide-react';

interface QuickCreateToolbarProps {
  project: Project | null;
  onOpenProjectPicker: () => void;
}

/**
 * Shared toolbar for quick-create dialogs: one pill showing the current project,
 * which opens the OpenProjectComponent on click (same modal used by the footer).
 */
export function QuickCreateToolbar({ project, onOpenProjectPicker }: QuickCreateToolbarProps) {
  const label = project?.displayName || project?.name || 'Select project';
  return (
    <div className="flex items-center gap-2 border-b border-border pb-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onOpenProjectPicker}
        className="h-7 gap-1.5 text-xs"
        title="Switch project or create a new one"
      >
        <FolderOpen className="h-3.5 w-3.5" />
        <span className="max-w-[240px] truncate">{label}</span>
      </Button>
    </div>
  );
}
