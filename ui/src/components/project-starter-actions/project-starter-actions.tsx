import { OpenProjectComponent } from '@src/components/open-project-component/open-project-component';
import { normalizePath, useProjectOpener } from '@src/components/open-project-component/use-open-project';
import { NewProjectDialog, NewProjectFromGitDialog, useGitCloneDialogSubmit } from '@src/components/project-selector';
import { notify } from '@src/notifications';
import { cn } from '@src/lib/utils';
import { dataContext } from '@sdk';
import { FolderOpen, FolderPlus, FolderSearch, GitBranch, Loader2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Trans } from '@lingui/react/macro';

/** Shared ghost-button style for the under-input project actions. */
const PROJECT_ACTION_BUTTON_CLASS =
  'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50';

/**
 * ProjectStarterActions — the row of "get me into a project" affordances that
 * sits under the home prompt: open a folder, open an existing project, create a
 * new one, clone from git.
 *
 * Lives here rather than in the Vibe hero because every home surface offers the
 * same four starting points — the Vibe hero (`VibeNewChat`) and the
 * Standard/Advanced landing (`HomeLanding`) both render this one row, so the
 * wording, the ordering and the dialogs can't drift apart between view modes.
 *
 * Owns its own dialogs: the buttons are the only things that open them, and the
 * row is never dismissed by a pick (unlike the quick-create modal's tiles).
 * Landing behaviour is surface-derived inside `useProjectOpener` — from a home
 * surface, picking a project stays home on the fresh landing.
 */
export function ProjectStarterActions({ className }: { className?: string }) {
  const [isProjectModalOpen, setIsProjectModalOpen] = useState(false);
  const [isNewProjectOpen, setIsNewProjectOpen] = useState(false);
  const [isGitProjectOpen, setIsGitProjectOpen] = useState(false);
  const [isOpeningFolder, setIsOpeningFolder] = useState(false);
  const defaultWorkspacePath = useMemo(() => dataContext.bootstrapInfo?.desktop_info?.paths?.workspace || '', []);

  const { openProjectFolder, pickFolder, ensureProjectAndSetContext, openExistingProject, computeNode } =
    useProjectOpener({
      onError: (message) => notify.error({ title: message }),
    });

  // Clone + open, with this surface's landing: from home we stay home (on the
  // fresh landing for the new project) rather than jumping to its dock.
  const handleCreateGitProject = useGitCloneDialogSubmit(computeNode?.id, openExistingProject);

  const handleOpenFolder = async () => {
    // openProjectFolder never throws — it routes failures through onError.
    setIsOpeningFolder(true);
    try {
      await openProjectFolder();
    } finally {
      setIsOpeningFolder(false);
    }
  };

  return (
    <>
      <div
        className={cn('flex w-full flex-wrap items-center gap-1.5', className)}
        data-testid="project-starter-actions"
      >
        <button
          type="button"
          onClick={() => void handleOpenFolder()}
          disabled={isOpeningFolder}
          className={PROJECT_ACTION_BUTTON_CLASS}
          data-testid="vibe-open-project-folder"
        >
          {isOpeningFolder ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
          ) : (
            <FolderOpen className="h-3.5 w-3.5 shrink-0" />
          )}
          <Trans>Open folder</Trans>
        </button>
        <button
          type="button"
          onClick={() => setIsProjectModalOpen(true)}
          className={PROJECT_ACTION_BUTTON_CLASS}
          data-testid="vibe-open-existing-project"
        >
          <FolderSearch className="h-3.5 w-3.5 shrink-0" />
          <Trans>Open existing project</Trans>
        </button>
        <button
          type="button"
          onClick={() => setIsNewProjectOpen(true)}
          className={PROJECT_ACTION_BUTTON_CLASS}
          data-testid="vibe-new-project"
        >
          <FolderPlus className="h-3.5 w-3.5 shrink-0" />
          <Trans>New project</Trans>
        </button>
        <button
          type="button"
          onClick={() => setIsGitProjectOpen(true)}
          className={PROJECT_ACTION_BUTTON_CLASS}
          data-testid="vibe-open-from-git"
        >
          <GitBranch className="h-3.5 w-3.5 shrink-0" />
          <Trans>Open from git</Trans>
        </button>
      </div>

      <OpenProjectComponent open={isProjectModalOpen} onOpenChange={setIsProjectModalOpen} />
      <NewProjectDialog
        open={isNewProjectOpen}
        onOpenChange={setIsNewProjectOpen}
        defaultParentFolder={defaultWorkspacePath}
        onPickFolder={() => pickFolder(defaultWorkspacePath || undefined)}
        onCreate={async (name, parentFolder) => {
          await ensureProjectAndSetContext(`${normalizePath(parentFolder)}/${name}`);
        }}
      />
      {/* Mounted only while open — keeps the repo/branch pickers out of the
          home route's eager module graph. */}
      {isGitProjectOpen && (
        <NewProjectFromGitDialog open onOpenChange={setIsGitProjectOpen} onCreate={handleCreateGitProject} />
      )}
    </>
  );
}
