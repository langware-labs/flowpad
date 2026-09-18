/**
 * RCA capture (2026-09-17): after switching to a project without git, the footer
 * git pill keeps showing the PREVIOUS project's repo.
 *
 * The footer reads `gitWorkdir = workdir || project.fs_storage_mount_path`
 * (`useProjectLocation`), so a stale `dataContext.workdir` IS the stale pill.
 * Both cases were proven live (probe + on/off lever in the browser):
 *   1. a scoped landing (`homeLoader` → `adoptScopeProject` → `loadProject`)
 *      switches the project but never writes `workdir`;
 *   2. two project navigations back to back — the superseded `loadProjectRoute`
 *      commits its project and workdir LAST, because the newer one's write to the
 *      still-committed project is a no-op.
 */
import { dataContext, Project } from '@sdk';
import { projectScope } from '@src/lib/scope-filter';
import { DockPointer } from '@src/navigation/DockPointer';
import { adoptScopeProject } from '@src/routes/loaders/load-dock-pointer';
import { loadProjectRoute } from '@src/routes/loaders/load-project';
import { beforeEach, describe, expect, it } from 'vitest';

const project = (id: string, mount: string) => {
  const p = new Project({ id, name: mount, fs_storage_mount_path: mount });
  p.markAsExpanded();
  return p;
};
const withGit = project('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '/work/with-git');
const noGit = project('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '/work/no-git');
const open = (p: Project) => loadProjectRoute(DockPointer.forProject(p.id).pointer);

describe('switching project re-points the git workdir', () => {
  beforeEach(() => open(withGit));

  it('a scoped landing on another project moves the workdir with it', async () => {
    await adoptScopeProject(DockPointer.forHome().withScopeFilter(projectScope(noGit.id)));

    expect(dataContext.project?.id).toBe(noGit.id);
    expect(dataContext.workdir).toBe(noGit.fs_storage_mount_path);
  });

  it('the latest of two back-to-back project navigations wins', async () => {
    await open(noGit);

    await Promise.all([open(withGit), open(noGit)]);

    expect(dataContext.project?.id).toBe(noGit.id);
    expect(dataContext.workdir).toBe(noGit.fs_storage_mount_path);
  });
});
