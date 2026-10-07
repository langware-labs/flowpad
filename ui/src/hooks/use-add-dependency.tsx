import { t } from '@lingui/core/macro';
import { useCallback, useState, type ReactNode } from 'react';
import { Trans } from '@lingui/react/macro';
import { launchWizard, type Project, type ProjectListItem } from '@sdk';
import { AddDependencyDialog } from '@src/components/assets/AddDependencyDialog';
import { HubProjectDependencyDialog } from '@src/components/assets/HubProjectDependencyDialog';
import { GitTargetDialog, type GitTarget } from '@src/components/git/GitTargetDialog';
import { ProjectPickerModal } from '@src/components/assets/ProjectPickerModal';
import type { DependencySource } from '@src/components/assets/dependency-sources';
import { useProjectDependencies, type DependencyKind } from '@src/hooks/use-project-dependencies';
import { notify } from '@src/notifications';

interface UseAddDependencyOptions {
  /** The project the dependency is added to. */
  project: Project | null | undefined;
  /** Ran after a dependency was added — the Assets view passes its entity
   *  refetch. */
  onAdded?: () => Promise<unknown> | void;
}

/**
 * useAddDependency — the one way to add a dependency, wherever it's offered:
 * the Assets navigator's "+" (via `openSource`, which shows the source dialog)
 * and the create-new surface's tiles (via `pick`, which runs a source
 * directly).
 *
 * Every dialog is rendered by the *caller*, through `dialogs`. That is not
 * incidental: each source is started by clicking something that then closes
 * (the source dialog, the create-new modal), so a dialog owned any closer to
 * the trigger would unmount before it could show.
 */
export function useAddDependency({ project, onAdded }: UseAddDependencyOptions) {
  const [sourceDialogOpen, setSourceDialogOpen] = useState(false);
  const [projectPickerKind, setProjectPickerKind] = useState<DependencyKind | null>(null);
  const [gitKind, setGitKind] = useState<DependencyKind | null>(null);
  const [hubKind, setHubKind] = useState<DependencyKind | null>(null);
  const { add, addPaths, pickAndAdd } = useProjectDependencies(project, { fetchStates: false });
  const projectId = project?.id ?? null;
  const projectTypeId = project?.typeId ?? null;

  /** Run an add and say so when it fails — a bad source answers with the
   *  backend's own sentence. */
  const guarded = useCallback(
    async (run: () => Promise<unknown>) => {
      try {
        await run();
        await onAdded?.();
      } catch (err) {
        notify.error({
          title: t`Failed to add dependency`,
          message: err instanceof Error ? err.message : undefined,
        });
      }
    },
    [onAdded],
  );

  // "Git repository" source, two steps: the tile opens a small form (an
  // existing repo — browsed or pasted, with its branch — vs. a new repo name,
  // GitTargetDialog); only its submit launches the git-dependency wizard
  // agent, seeded with that input, which does the clone/init + remote work in
  // the Flowpad workspace as its own project and ends with `flow dep add` —
  // the watched project entity then re-renders the rows. `done`/`cancel` need
  // no follow-up; a wizard-level error surfaces here.
  const handleGitSubmit = useCallback(
    async (input: GitTarget) => {
      // Kind is null only when the dialog is closed, which is when this can't
      // fire — bail rather than invent a default that would quietly file an
      // optional dependency as required.
      if (!projectId || gitKind === null) return;
      const optional = gitKind === 'optional';
      setGitKind(null);
      try {
        const result = await launchWizard<{ path?: string; newProjectId?: string }>('git-dependency', {
          title: t`Add Git dependency`,
          targetTypeId: projectTypeId?.toString(),
          payload: { projectId, optional, ...input },
          prompt:
            input.mode === 'existing'
              ? `Set up the existing git repository ${input.url}${
                  input.branch ? ` on branch ${input.branch}` : ''
                } as a dependency of this project.`
              : `Create a new git repository named "${input.name}" and add it as a dependency of this project.`,
        });
        if (result.status === 'error') {
          notify.error({ title: t`Failed to add Git dependency`, message: result.errorStr ?? undefined });
        }
        if (result.status === 'done') {
          // The wizard mutated the project via its own calls — force a fresh
          // entity fetch so the Dependencies rows appear without a page reload
          // (the WS update can race/miss computed fields).
          await onAdded?.();
        }
      } catch (err) {
        notify.error({
          title: t`Failed to add Git dependency`,
          message: err instanceof Error ? err.message : undefined,
        });
      }
    },
    [gitKind, projectId, projectTypeId, onAdded],
  );

  const pick = useCallback(
    (source: DependencySource, kind: DependencyKind) => {
      if (!projectId) return;
      if (source === 'project') setProjectPickerKind(kind);
      if (source === 'browse') void guarded(() => pickAndAdd(kind));
      if (source === 'git') setGitKind(kind);
      if (source === 'hub') setHubKind(kind);
    },
    [projectId, pickAndAdd, guarded],
  );

  const handleProjectsConfirm = useCallback(
    (_ids: string[], items: ProjectListItem[]) => {
      if (projectPickerKind === null) return;
      const paths = items.map((p) => p.cwd).filter((c): c is string => !!c);
      const kind = projectPickerKind;
      setProjectPickerKind(null);
      if (paths.length) void guarded(() => addPaths(paths, kind));
    },
    [addPaths, projectPickerKind, guarded],
  );

  const handleHubSubmit = useCallback(
    async (source: string) => {
      // Throws to the dialog, which shows the backend's reason in place.
      await add(source, hubKind ?? 'required');
      await onAdded?.();
    },
    [add, hubKind, onAdded],
  );

  // Stable — the Assets tree memoizes its roots on this.
  const openSource = useCallback(() => setSourceDialogOpen(true), []);

  const dialogs: ReactNode = (
    <>
      <AddDependencyDialog open={sourceDialogOpen} onOpenChange={setSourceDialogOpen} onPick={pick} />
      <ProjectPickerModal
        open={projectPickerKind !== null}
        onOpenChange={(next) => !next && setProjectPickerKind(null)}
        selectedIds={[]}
        onConfirm={handleProjectsConfirm}
        description={<Trans>Each selected project's folder is added as a dependency.</Trans>}
      />
      <GitTargetDialog
        open={gitKind !== null}
        onOpenChange={(next) => !next && setGitKind(null)}
        title={<Trans>Add Git dependency</Trans>}
        description={<Trans>Add a git repository this project depends on.</Trans>}
        submitLabel={<Trans>Add</Trans>}
        testIdPrefix="add-git-dependency"
        onSubmit={handleGitSubmit}
      />
      <HubProjectDependencyDialog
        open={hubKind !== null}
        onOpenChange={(next) => !next && setHubKind(null)}
        excludeProjectId={projectId}
        onSubmit={handleHubSubmit}
      />
    </>
  );

  return { openSource, pick, dialogs };
}
