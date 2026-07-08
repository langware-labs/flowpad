import React, { useCallback, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { Trans } from '@lingui/react/macro';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { ProjectPickerModal } from './ProjectPickerModal';
import type { ProjectListItem } from '@sdk';

interface AddContextFolderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Add the given absolute folder paths as context folders. */
  onAddPaths: (paths: string[]) => void | Promise<void>;
  /** "Open folder" source: native folder picker → add. Owned by the host
   *  (it holds the compute node). */
  onBrowse: () => void | Promise<void>;
}

/** A desktop-icon-style source tile (icon above a small label), mirroring the
 *  home grid's tile grammar. */
function SourceTile({
  icon,
  label,
  onClick,
  testId,
}: {
  icon: React.ReactNode;
  label: React.ReactNode;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className="flex h-24 w-24 cursor-pointer flex-col items-center justify-center gap-2 rounded-md border border-border bg-background text-muted-foreground transition-colors hover:border-primary hover:bg-accent hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {icon}
      <span className="max-w-[88px] truncate text-[11px] font-medium leading-none">{label}</span>
    </button>
  );
}

/**
 * AddContextFolderDialog — the "+" flow for project context folders. Presents
 * the folder sources as home-style icon tiles:
 *   - "Project folder": pick projects (the simple project select); each
 *     selected project's folder (cwd) is added as a context folder.
 *   - "Open folder": the native folder picker.
 */
export function AddContextFolderDialog({
  open,
  onOpenChange,
  onAddPaths,
  onBrowse,
}: AddContextFolderDialogProps): React.ReactElement {
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const ProjectIcon = iconForType('project');

  const handleProjectsConfirm = useCallback(
    (_ids: string[], items: ProjectListItem[]) => {
      const paths = items.map((p) => p.cwd).filter((c): c is string => !!c);
      setProjectPickerOpen(false);
      onOpenChange(false);
      if (paths.length) void onAddPaths(paths);
    },
    [onAddPaths, onOpenChange],
  );

  const handleBrowse = useCallback(() => {
    onOpenChange(false);
    void onBrowse();
  }, [onBrowse, onOpenChange]);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-xs" data-testid="add-context-folder-dialog">
          <DialogHeader>
            <DialogTitle><Trans>Add context folder</Trans></DialogTitle>
            <DialogDescription>
              <Trans>Include another folder in this project's context.</Trans>
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center justify-center gap-3 py-2">
            <SourceTile
              icon={<ProjectIcon className="h-8 w-8" />}
              label={<Trans>Project folder</Trans>}
              onClick={() => setProjectPickerOpen(true)}
              testId="add-context-folder-project"
            />
            <SourceTile
              icon={<FolderOpen className="h-8 w-8" />}
              label={<Trans>Open folder</Trans>}
              onClick={handleBrowse}
              testId="add-context-folder-browse"
            />
          </div>
        </DialogContent>
      </Dialog>
      <ProjectPickerModal
        open={projectPickerOpen}
        onOpenChange={setProjectPickerOpen}
        selectedIds={[]}
        onConfirm={handleProjectsConfirm}
        description={<Trans>Each selected project's folder is added as a context folder.</Trans>}
      />
    </>
  );
}
