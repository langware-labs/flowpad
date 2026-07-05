/**
 * RCA capture: opening an asset-editor VFS URL must load the asset's OWNING
 * project into context.
 *
 * Proven root cause (this session): `loadAssetRoute` (src/routes/loaders/
 * load-asset.ts) VFS branch resolves the backing entity and calls
 * `setActiveEntityTypeId(e.typeId)` but NEVER reads `e.project_id` to set
 * `CurrentProjectTypeId`. Observed live on the running app for the exact URL
 * in the report: activeEntity = skill-149ed94a… (correct), but
 * CurrentProjectTypeId stayed `project-@local` instead of the skill's owning
 * project `8463c0d4…` (the project named "/private/tmp").
 *
 * This test reproduces the bug through the REAL mechanism — no mocks. It drives
 * the real backend, the real `dataManager.getEntityByPath` (`/assets/entity`),
 * the real `loadAssetRoute`, and the real `dataContext`:
 *   1. resolve the skill by its VFS path (the loader's own resolution step) and
 *      confirm the backend returns its owning project_id (the data the loader
 *      needs IS present),
 *   2. seed context with a DIFFERENT sentinel project,
 *   3. run the REAL `loadAssetRoute` for the skill's VFS pointer,
 *   4. assert CurrentProjectTypeId became the skill's project.
 *
 * With the bug: the project context stays the sentinel → assertion fails.
 * After the fix (loader sets the project from e.project_id): it passes.
 *
 * Fixture: the skill `/private/tmp/.claude/skills/shopiing` from the report,
 * which lives on this dev instance. Requires a running backend at
 * localhost:$LOCAL_SERVER_PORT (react project).
 */
import {
  AssetEditor,
  ContextEntitiesEnum,
  Project,
  Skill,
  TypeId,
  dataContext,
  dataManager,
} from '@sdk';
import { AssetDocPointer } from '@src/navigation/AssetDocPointer';
import { loadAssetRoute } from '@src/routes/loaders/load-asset';
import { beforeEach, describe, expect, it } from 'vitest';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

// The exact asset from the report.
const SKILL_PATH = '/private/tmp/.claude/skills/shopiing';
// The skill's owning project root — a project whose name is this absolute path
// mounts here, so the scoped skill materializes at `<PROJECT_ROOT>/.claude/skills/shopiing`.
const PROJECT_ROOT = '/private/tmp';
// A real, unrelated project to seed as the pre-existing context so the
// assertion is meaningful: if the loader never sets the project, the context
// keeps this sentinel rather than coincidentally matching the skill's project.
const SENTINEL_PROJECT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('loadAssetRoute — VFS asset loads its owning project into context', () => {
  beforeEach(async (ctx: any) => {
    await apiTestSetup(getTestSignupInfo(), ctx.task.name);
  });

  it('sets CurrentProjectTypeId to the skill VFS entity project_id', async () => {
    // 0. Materialize the fixture the report references — a skill named `shopiing`
    //    living under the project rooted at `/private/tmp`. A project whose
    //    `name` is an absolute path gets `fs_storage_mount_path` = that path
    //    (backend `Project.set_fs_storage_mount_path`), and a skill created under
    //    that project scope is written to `<mount>/.claude/skills/<name>/` with
    //    `project_id` + `asset_ref` stamped server-side (`_prepare_for_storage`).
    //    Idempotent: skip when the fixture already exists on this instance.
    await dataManager.clearCache();
    if (!(await dataManager.getEntityByPath<Skill>(SKILL_PATH))) {
      const project = await new Project({ name: PROJECT_ROOT }).save();
      await Skill.createInProject(project, 'shopiing');
      await dataManager.clearCache();
    }

    // 1. Resolve the skill exactly as the loader does — by VFS path.
    const skill = await dataManager.getEntityByPath<Skill>(SKILL_PATH);
    expect(skill, `fixture skill ${SKILL_PATH} must exist on this instance`).toBeTruthy();
    const projectId: string = (skill as any).project_id;
    expect(projectId, 'backend must stamp the skill with its owning project_id').toMatch(
      /^[0-9a-f-]{36}$/,
    );
    const assetRef: string = (skill as any).asset_ref;
    expect(assetRef, 'skill must have an asset_ref path').toBeTruthy();

    // 2. Pre-existing context points at an unrelated sentinel project.
    await dataContext.setContextEntityTypeId(
      ContextEntitiesEnum.CurrentProjectTypeId,
      new TypeId(Project.type, SENTINEL_PROJECT_ID),
    );
    expect(
      dataContext.getContextEntityTypeId(ContextEntitiesEnum.CurrentProjectTypeId)?.id,
    ).toBe(SENTINEL_PROJECT_ID);

    // 3. Run the REAL asset loader for this skill's VFS pointer, exactly as the
    //    dock loader does for `/dock/assets/editor/skill/vfs/<value>`.
    const pointer = AssetDocPointer.forVfs(AssetEditor.SKILL, assetRef).toPointer();
    await loadAssetRoute(pointer);

    // Sanity: the loader DID resolve + activate the entity (its one working step).
    expect(
      dataContext.getContextEntityTypeId(ContextEntitiesEnum.CurrentActiveEntityTypeId)?.id,
      'loader should set the active entity',
    ).toBe(skill!.id);

    // 4. The bug: the project context must follow the asset to its owning
    //    project, but the loader never sets it — so it stays the sentinel.
    expect(
      dataContext.getContextEntityTypeId(ContextEntitiesEnum.CurrentProjectTypeId)?.id,
      'opening the skill must load its owning project into context',
    ).toBe(projectId);
  }, 15000);
});
