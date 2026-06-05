import { ContextEntitiesEnum, dataContext, Project, QueryRequest } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useCallback } from 'react';

export function canonicalPath(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/\/+$/, '').replace(/^\/+/, '');
}

/**
 * Idempotent project ensure-and-select used by both the QuickCreate flows and
 * the Home `+` menu's "Project (local)" / "Project (git)" entries.
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
      await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentProjectTypeId, target.typeId);
      await dataContext.refreshProject();
      dataContext.setWorkdir(target.fs_storage_mount_path ?? null);
      navigation.openDock(DockPointer.forProject(target.id));
      return target;
    },
    [navigation],
  );
}

/**
 * Companion helper for the "Project (git)" flow: the backend has already
 * cloned + saved the Project. We only need steps 3–5 of `useEnsureProject`.
 */
export function useSelectExistingProject() {
  const { navigation } = useDockNavigation();

  return useCallback(
    async (project: Project): Promise<void> => {
      await project.setupForDesktop();
      await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentProjectTypeId, project.typeId);
      await dataContext.refreshProject();
      dataContext.setWorkdir(project.fs_storage_mount_path ?? null);
      navigation.openDock(DockPointer.forProject(project.id));
    },
    [navigation],
  );
}
