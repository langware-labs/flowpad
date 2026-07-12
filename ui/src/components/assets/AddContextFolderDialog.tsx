import React, { useCallback, useState } from 'react';
import { FolderOpen, Lock, Users } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import type { ContextFolderScope } from '@src/hooks/use-project-context-folders';
import { ProjectPickerModal } from './ProjectPickerModal';
import type { ProjectListItem } from '@sdk';

interface AddContextFolderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Add the given absolute folder paths as context folders. */
  onAddPaths: (paths: string[], scope: ContextFolderScope) => void | Promise<void>;
  /** "Open folder" source: native folder picker → add. Owned by the host
   *  (it holds the compute node). */
  onBrowse: (scope: ContextFolderScope) => void | Promise<void>;
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
  const { t } = useLingui();
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [scope, setScope] = useState<ContextFolderScope>('private');
  const ProjectIcon = iconForType('project');

  const handleProjectsConfirm = useCallback(
    (_ids: string[], items: ProjectListItem[]) => {
      const paths = items.map((p) => p.cwd).filter((c): c is string => !!c);
      setProjectPickerOpen(false);
      onOpenChange(false);
      if (paths.length) void onAddPaths(paths, scope);
    },
    [onAddPaths, onOpenChange, scope],
  );

  const handleBrowse = useCallback(() => {
    onOpenChange(false);
    void onBrowse(scope);
  }, [onBrowse, onOpenChange, scope]);

  const scopeOptions: { value: ContextFolderScope; icon: React.ReactNode; label: React.ReactNode; title: string }[] = [
    {
      value: 'private',
      icon: <Lock className="h-3 w-3" />,
      label: <Trans>Private</Trans>,
      title: t`Only on this machine — never shared`,
    },
    {
      value: 'shared',
      icon: <Users className="h-3 w-3" />,
      label: <Trans>Shared</Trans>,
      title: t`Travels with the project when shared`,
    },
  ];

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
          <div className="flex items-center justify-center gap-1" role="radiogroup">
            {scopeOptions.map((opt) => (
              <button
                key={opt.value}
                type="button"
                role="radio"
                aria-checked={scope === opt.value}
                title={opt.title}
                onClick={() => setScope(opt.value)}
                data-testid={`add-context-folder-scope-${opt.value}`}
                className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors ${
                  scope === opt.value
                    ? 'border-primary bg-primary/10 text-foreground'
                    : 'border-border text-muted-foreground hover:border-primary/50 hover:text-foreground'
                }`}
              >
                {opt.icon}
                {opt.label}
              </button>
            ))}
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
