import { OpenProjectComponent } from '@src/components/open-project-component/open-project-component';
import { normalizePath, useProjectOpener } from '@src/components/open-project-component/use-open-project';
import { NewProjectDialog, NewProjectFromGitDialog, useGitCloneDialogSubmit } from '@src/components/project-selector';
import { notify } from '@src/notifications';
import { dataContext } from '@sdk';
import { isHubOnly } from '@src/navigation/hub-runtime';
import { DesktopTile } from '@src/components/quick-create/QuickCreatePanel';
import { useProjects } from '@src/hooks/use-projects';
import { FolderOpen, FolderPlus, FolderSearch, GitBranch, Loader2 } from 'lucide-react';
import { useMemo, useState, type ComponentType } from 'react';
import { useLingui } from '@lingui/react/macro';

/** Ghost-link presentation — the Vibe hero's under-input strip. */
const LINK_CLASS =
  'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50';

/** One action, in whichever presentation the host asked for. */
function ActionButton({
  variant,
  Icon,
  label,
  loading,
  onClick,
  testId,
}: {
  variant: 'tiles' | 'links';
  Icon: ComponentType<{ className?: string }>;
  label: string;
  loading?: boolean;
  onClick: () => void;
  testId: string;
}) {
  if (variant === 'tiles') {
    return <DesktopTile Icon={Icon} label={label} loading={loading} onClick={onClick} data-testid={testId} />;
  }
  return (
    <button type="button" onClick={onClick} disabled={loading} className={LINK_CLASS} data-testid={testId}>
      {loading ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" /> : <Icon className="h-3.5 w-3.5 shrink-0" />}
      {label}
    </button>
  );
}

/**
 * The project-actions row — Open folder / Open existing project / New project /
 * Open from git — plus the three dialogs they drive.
 *
 * Two presentations of the SAME actions, chosen by the host: `tiles` (the
 * icon-over-label square project home uses for its "New …" affordances — hub
 * home) and `links` (the Vibe hero's slim under-input strip). Only the shape
 * differs; the action set and every flow behind it stay in this one component.
 *
 * One component, shared by every home surface that offers "get me into a
 * project" (the Vibe hero and the hub page's Projects section), so the set of
 * affordances and their flows can't drift apart.
 *
 * The hub has projects and a current project like the desktop does — it just
 * reaches its files over the VFS with git as the filesystem. So only ONE action
 * is desk-specific: **Open folder**, which drives the host's native folder
 * picker and has nothing to point at on a hub-only server (`isHubOnly()`).
 * It — and the "Browse" affordance inside the New-project dialog, same native
 * picker — is the only thing dropped there; open-existing / new / from-git all
 * work against the hub.
 *
 * **Open existing project** is gated on there BEING one: with an empty project
 * list the picker it opens has nothing to pick, so the tile would be a dead end.
 * The create-flavoured actions always show, so an empty home is never a wall.
 */
export function ProjectActionsRow({
  className = '',
  variant = 'links',
}: {
  className?: string;
  variant?: 'tiles' | 'links';
}) {
  const { t } = useLingui();
  const [isProjectModalOpen, setIsProjectModalOpen] = useState(false);
  const [isNewProjectOpen, setIsNewProjectOpen] = useState(false);
  const [isGitProjectOpen, setIsGitProjectOpen] = useState(false);
  const [isOpeningFolder, setIsOpeningFolder] = useState(false);
  const defaultWorkspacePath = useMemo(() => dataContext.bootstrapInfo?.desktop_info?.paths?.workspace || '', []);
  const { projects } = useProjects();
  const hasProjects = !!projects && projects.length > 0;

  // On a home surface, opening/switching a project just changes the project and
  // lands on the fresh home (never resumes an old build process) — that
  // decision lives inside useProjectOpener, derived from the current surface.
  const { openProjectFolder, pickFolder, ensureProjectAndSetContext, openExistingProject, computeNode } =
    useProjectOpener({
      onError: (message) => notify.error({ title: message }),
    });

  // Clone + open, with this surface's landing: from home we stay home (on the
  // fresh hero for the new project) rather than jumping to its dock.
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

  // Native host folder picker — the one action with no meaning over the hub's
  // git-backed VFS.
  const canPickHostFolder = !isHubOnly();

  return (
    <>
      <div
        className={`flex flex-wrap items-center ${variant === 'tiles' ? 'gap-3' : 'gap-1.5'} ${className}`}
        data-testid="project-actions-row"
      >
        {canPickHostFolder && (
          <ActionButton
            variant={variant}
            Icon={FolderOpen}
            label={t`Open folder`}
            loading={isOpeningFolder}
            onClick={() => void handleOpenFolder()}
            testId="vibe-open-project-folder"
          />
        )}
        {hasProjects && (
          <ActionButton
            variant={variant}
            Icon={FolderSearch}
            label={t`Open project`}
            onClick={() => setIsProjectModalOpen(true)}
            testId="vibe-open-existing-project"
          />
        )}
        <ActionButton
          variant={variant}
          Icon={FolderPlus}
          label={t`New project`}
          onClick={() => setIsNewProjectOpen(true)}
          testId="vibe-new-project"
        />
        <ActionButton
          variant={variant}
          Icon={GitBranch}
          label={t`Open from git`}
          onClick={() => setIsGitProjectOpen(true)}
          testId="vibe-open-from-git"
        />
      </div>
      <OpenProjectComponent open={isProjectModalOpen} onOpenChange={setIsProjectModalOpen} />
      <NewProjectDialog
        open={isNewProjectOpen}
        onOpenChange={setIsNewProjectOpen}
        defaultParentFolder={defaultWorkspacePath}
        onPickFolder={canPickHostFolder ? () => pickFolder(defaultWorkspacePath || undefined) : undefined}
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
