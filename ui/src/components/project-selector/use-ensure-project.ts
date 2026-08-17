import { ContextEntitiesEnum, dataContext, gitOriginFromUrl, Project, QueryRequest } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { isHubOnly } from '@src/navigation/hub-runtime';
import { useSandboxes } from '@src/hooks/use-sandboxes';
import { useCallback } from 'react';

export function canonicalPath(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/\/+$/, '').replace(/^\/+/, '');
}

/** Make `project` the active project context — current-project pointer,
 *  refreshed project snapshot, workdir. Shared by the select flows below and
 *  by callers that adopt a project without navigating to it. */
export async function selectProjectContext(project: Project): Promise<void> {
  await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentProjectTypeId, project.typeId);
  await dataContext.refreshProject();
  dataContext.setWorkdir(project.fs_storage_mount_path ?? null);
}

/**
 * Idempotent project ensure-and-select used by both the QuickCreate flows and
 * the Home `+` menu's "Project (local)" / "From git" entries.
 *
 * Steps:
 *   1. dedup by canonical mount-path against the latest Project query
 *   2. create-and-save if missing
 *   3. wire the project to desktop (@local workspace + compute node)
 *   4. set it as the active project + workdir
 *   5. navigate URL-first to /dock/project/<id>
 *
 * Pass `{ select: false }` to stop after step 3 — the project is ensured and
 * desktop-wired, but the active context and URL are left untouched (for
 * callers that drive their own navigation, e.g. launching a process on the
 * picked project).
 */
export function useEnsureProject() {
  const { navigation } = useDockNavigation();

  return useCallback(
    async (rawPath: string, options?: { select?: boolean }): Promise<Project> => {
      if (!dataContext.someone) throw new Error('You must be logged in');
      const normalized = rawPath.trim().replace(/\\/g, '/').replace(/\/+$/, '');
      if (!normalized) throw new Error('Please provide a valid project path');
      const pathKey = canonicalPath(normalized);

      const freshProjects = await Project.query(
        new QueryRequest({ type: Project.type, query: null, scope: [], name: 'ensure-project-dedup' }),
      );
      let target = freshProjects.find((p) => canonicalPath(p.fs_storage_mount_path ?? '') === pathKey) ?? null;
      if (!target) {
        target = await new Project({ name: normalized }).save([dataContext.someone]);
      }
      await target.setupForDesktop();
      if (options?.select === false) return target;
      await selectProjectContext(target);
      navigation.openDock(DockPointer.forProject(target.id));
      return target;
    },
    [navigation],
  );
}

/** Where a project-open flow LANDS, once the project is adopted. */
export type ProjectLanding = (project: Project) => void | Promise<void>;

/**
 * Default landing: go to the project's own dock. Callers on a home surface
 * pass `useProjectOpener().openExistingProject` instead, which stays home.
 */
export function useSelectExistingProject(): ProjectLanding {
  const { navigation } = useDockNavigation();

  return useCallback(
    async (project: Project): Promise<void> => {
      await selectProjectContext(project);
      navigation.openDock(DockPointer.forProject(project.id));
    },
    [navigation],
  );
}

/**
 * Shared "clone a git repo into a fresh Project, then open it" step, used by
 * the QuickCreate "From git" flow, the Vibe home hero, and the
 * received-template `IncomingProjectDialog`. Centralizes the
 * `Project.createFromGitUrl` result contract (ok / collision / error), the
 * desktop wiring, and the open-on-success, so the call sites can't drift.
 *
 * `landing` overrides where a successful clone lands (default: the project's
 * dock). It's the ONLY thing that legitimately varies between call sites —
 * pass a stable (memoized) callback. Returns the raw result; each caller maps
 * it to its own UI (form banner vs. step machine).
 */
export function useCloneGitProjectAndOpen(landing?: ProjectLanding) {
  const selectExisting = useSelectExistingProject();
  const land = landing ?? selectExisting;

  return useCallback(
    async (computeNodeId: string, url: string, opts?: { targetName?: string; branch?: string }) => {
      const result = await Project.createFromGitUrl(computeNodeId, url, opts?.targetName, opts?.branch);
      if (result.kind === 'ok') {
        await result.project.setupForDesktop();
        await land(result.project);
      }
      return result;
    },
    [land],
  );
}

/**
 * The `NewProjectFromGitDialog.onCreate` adapter: maps the clone result onto
 * the shape the dialog speaks (`{ok:true}` closes it, `{ok:false, …}` shows the
 * name-collision banner, a throw shows an error toast). Lives here with the
 * result contract it decodes so a new `kind` is handled in one place rather
 * than in every dialog that hosts the form.
 */
/**
 * The clone-dialog's submit, for whichever runtime is serving the app.
 *
 * **Desk** clones onto the local compute node — the path this hook has always
 * taken. **Hub** has no compute node (its bootstrap ships no
 * `default_compute_node`) and no local filesystem, so a clone there targets an
 * E2B sandbox instead: `launch({sandboxProject})` has the HUB clone the repo — with
 * the user's token, which is why private repos work at all — and copy the tree
 * into the box, which materializes it into an indexed Project. Same pipeline
 * `InstallLanding` uses; nothing new on either side.
 */
export function useGitCloneDialogSubmit(computeNodeId: string | null | undefined, landing?: ProjectLanding) {
  const cloneAndOpen = useCloneGitProjectAndOpen(landing);
  const { launch } = useSandboxes();

  return useCallback(
    async (
      url: string,
      acceptSuggested?: string,
      branch?: string,
    ): Promise<{ ok: true } | { ok: false; suggestedName: string; attemptedName: string }> => {
      if (isHubOnly()) {
        const gitOrigin = gitOriginFromUrl(url, branch ?? '');
        if (!gitOrigin) throw new Error('Not a recognisable git URL');
        // The repo name is the box-side folder/project name. A fresh sandbox
        // can't collide, but a re-used one can — the launch pipeline asks the
        // box before it clones, and reports the clash the same way the desk
        // path does so the dialog's existing banner handles both.
        const name = acceptSuggested || gitOrigin.name;
        await launch({ name, sandboxProject: { name, gitOrigin } });
        return { ok: true };
      }

      if (!computeNodeId) throw new Error('No compute node available');
      const result = await cloneAndOpen(computeNodeId, url, { targetName: acceptSuggested, branch });
      if (result.kind === 'ok') return { ok: true };
      if (result.kind === 'collision') {
        return { ok: false, suggestedName: result.suggestedName, attemptedName: result.attemptedName };
      }
      throw new Error(result.message);
    },
    [cloneAndOpen, computeNodeId, launch],
  );
}
