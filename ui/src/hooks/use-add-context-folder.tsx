import { t } from '@lingui/core/macro';
import { useCallback, useState, type ReactNode } from 'react';
import { Trans } from '@lingui/react/macro';
import { launchWizard, type Project, type ProjectListItem } from '@sdk';
import { AddContextFolderDialog } from '@src/components/assets/AddContextFolderDialog';
import { AddGitFolderDialog, type GitFolderInput } from '@src/components/assets/AddGitFolderDialog';
import { ProjectPickerModal } from '@src/components/assets/ProjectPickerModal';
import type { ContextFolderSource } from '@src/components/assets/context-folder-sources';
import { useProjectContextFolders, type ContextFolderScope } from '@src/hooks/use-project-context-folders';
import { notify } from '@src/notifications';

interface UseAddContextFolderOptions {
  /** The project the folder is attached to. */
  project: Project | null | undefined;
  /** Ran after the git wizard reports done — the Assets view passes its entity
   *  refetch. */
  onAdded?: () => Promise<unknown> | void;
}

/**
 * useAddContextFolder — the one way to add a context folder, wherever it's
 * offered: the Assets navigator's "+" (via `openSource`, which shows the source
 * dialog) and the create-new surface's folder tiles (via `pick`, which runs a
 * source directly).
 *
 * Every dialog is rendered by the *caller*, through `dialogs`. That is not
 * incidental: each source is started by clicking something that then closes
 * (the source dialog, the create-new modal), so a dialog owned any closer to
 * the trigger would unmount before it could show.
 */
export function useAddContextFolder({ project, onAdded }: UseAddContextFolderOptions) {
  const [sourceDialogOpen, setSourceDialogOpen] = useState(false);
  const [projectPickerScope, setProjectPickerScope] = useState<ContextFolderScope | null>(null);
  const [gitScope, setGitScope] = useState<ContextFolderScope | null>(null);
  const { addPaths, pickAndAdd } = useProjectContextFolders(project);
  const projectId = project?.id ?? null;
  const projectTypeId = project?.typeId ?? null;

  // "Add Git folder" source, two steps: the tile opens a small form (existing
  // repo URL vs. new repo name — AddGitFolderDialog); only its submit launches
  // the git-context-folder wizard agent, seeded with that input, which does
  // the clone/init + remote work in the Flowpad workspace as its own project
  // and calls add-context-dir itself — the watched project entity then
  // re-renders the rows. `done`/`cancel` need no follow-up; a wizard-level
  // error surfaces here.
  const handleGitSubmit = useCallback(
    async (input: GitFolderInput) => {
      // Scope is null only when the dialog is closed, which is when this can't
      // fire — bail rather than invent a default that would quietly file a
      // shared folder as private.
      if (!projectId || gitScope === null) return;
      const scope = gitScope;
      setGitScope(null);
      try {
        const result = await launchWizard<{ path?: string; newProjectId?: string }>('git-context-folder', {
          title: t`Add Git folder`,
          targetTypeId: projectTypeId?.toString(),
          payload: { projectId, scope, ...input },
          prompt:
            input.mode === 'existing'
              ? `Set up the existing git repository ${input.url} as a context folder on this project.`
              : `Create a new git repository named "${input.name}" and set it up as a context folder on this project.`,
        });
        if (result.status === 'error') {
          notify.error({ title: t`Failed to add Git folder`, message: result.errorStr ?? undefined });
        }
        if (result.status === 'done') {
          // The wizard mutated the project via its own HTTP calls — force a
          // fresh entity fetch so the Context-folders rows appear without a
          // page reload (the WS update can race/miss computed fields).
          await onAdded?.();
        }
      } catch (err) {
        notify.error({
          title: t`Failed to add Git folder`,
          message: err instanceof Error ? err.message : undefined,
        });
      }
    },
    [gitScope, projectId, projectTypeId, onAdded],
  );

  const pick = useCallback(
    (source: ContextFolderSource, scope: ContextFolderScope) => {
      if (!projectId) return;
      if (source === 'project') setProjectPickerScope(scope);
      if (source === 'browse') void pickAndAdd(scope);
      if (source === 'git') setGitScope(scope);
    },
    [projectId, pickAndAdd],
  );

  const handleProjectsConfirm = useCallback(
    (_ids: string[], items: ProjectListItem[]) => {
      if (projectPickerScope === null) return;
      const paths = items.map((p) => p.cwd).filter((c): c is string => !!c);
      const scope = projectPickerScope;
      setProjectPickerScope(null);
      if (paths.length) void addPaths(paths, scope);
    },
    [addPaths, projectPickerScope],
  );

  // Stable — the Assets tree memoizes its roots on this.
  const openSource = useCallback(() => setSourceDialogOpen(true), []);

  const dialogs: ReactNode = (
    <>
      <AddContextFolderDialog open={sourceDialogOpen} onOpenChange={setSourceDialogOpen} onPick={pick} />
      <ProjectPickerModal
        open={projectPickerScope !== null}
        onOpenChange={(next) => !next && setProjectPickerScope(null)}
        selectedIds={[]}
        onConfirm={handleProjectsConfirm}
        description={<Trans>Each selected project's folder is added as a context folder.</Trans>}
      />
      <AddGitFolderDialog
        open={gitScope !== null}
        onOpenChange={(next) => !next && setGitScope(null)}
        onSubmit={handleGitSubmit}
      />
    </>
  );

  return { openSource, pick, dialogs };
}
