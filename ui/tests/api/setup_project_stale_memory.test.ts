/**
 * A browser memory that no longer resolves must STEP ASIDE, not decide.
 *
 * `setupProject` used to end in `targetProject ??= projects[0]`. A remembered
 * project id that this machine does not have — deleted since, a rebuilt database
 * with fresh ids, storage carried over from another machine — therefore did two
 * harmful things at once: it suppressed the server's considered answer (because
 * `initSdk` skips `default_project` whenever localStorage holds ANYTHING), and
 * then picked by list order, which is not a policy. On a sandbox `projects[0]`
 * is the @local starter project, so a stale entry silently landed the user in
 * `my_first_project` — the FLOWPAD-2004 symptom, client side.
 *
 * The browser is still checked first and still wins when it resolves; that order
 * is covered by the sibling case below. This pins only the not-found branch.
 *
 * OFFICIAL CLIENT ONLY (rca skill rule 6): apiTestSetup + the tier's own config,
 * backend resolved from `.env.<FLOW_INSTANCE>.local`.
 *
 * SETUP THE ASSERTION DEPENDS ON. `default_project` must differ from
 * `projects[0]`, or the fix and the bug give the same answer and a green here
 * would prove nothing — the first test throws rather than pass vacuously. The
 * generic project query orders by `updated_date`, so the shape to build is a
 * project that was OPENED last and a different one that was TOUCHED last:
 *
 *     scripts/instance_ctl.sh launch dev-1
 *     # against that instance, in order:
 *     #   1. materialize project A, POST project/<A>/activate   → last OPENED
 *     #   2. materialize project B, do NOT activate it          → last TOUCHED
 *     FLOW_INSTANCE=dev-1 npx vitest run --project api \
 *         tests/api/setup_project_stale_memory.test.ts
 *
 * That split is the real incident in miniature: on the reported sandbox a
 * background git scan kept bumping `my_first_project`'s row while the user's
 * actual project sat untouched, so "most recently updated" and "where the user
 * was" pointed at different projects.
 */
import { ContextEntitiesEnum, dataContext, Project, QueryRequest, TypeId, User } from '@sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

const STORAGE_KEY = 'flowpad-state';

function rememberProject(typeid: string | null): void {
  const state = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  if (typeid) state[ContextEntitiesEnum.CurrentProjectTypeId] = typeid;
  else delete state[ContextEntitiesEnum.CurrentProjectTypeId];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

async function listProjects(): Promise<Project[]> {
  return await Project.query(new QueryRequest({ type: Project.type, name: 'stale-memory test list' }), true);
}

// flowpad:capsule tag
// version: 1
// data:
//   tags:
//     breadcrumb.test.bootstrap_default_project.rules: FAILING? read this tag's rules
//       before editing — a dead browser memory must defer to default_project, never
//       pick by list order
// flowpad:endcapsule tag
describe('setupProject with a stale browser memory', () => {
  const signupInfo = getTestSignupInfo();

  beforeEach(async (context: any) => {
    await apiTestSetup(signupInfo, context.task.name);
    // `setupProject` returns immediately without a user in context, and
    // `apiTestSetup` builds the @local user without putting it there. This is the
    // same two lines `initSdk` runs (`ts_sdk/src/main.ts:139-141`) — the real
    // precondition of the code under test, not a stand-in for it.
    const bootUser = dataContext.bootstrapInfo?.user;
    expect(bootUser, 'bootstrap served no @local user').toBeTruthy();
    const user = new User(bootUser);
    user.markAsExpanded();
    await dataContext.setContextEntityTypeId(ContextEntitiesEnum.LocalUserTypeId, user.typeId);
  });

  it('defers to the server rather than grabbing the first project on the list', async () => {
    const serverChoice = dataContext.bootstrapInfo?.default_project?.id as string | undefined;
    expect(serverChoice, 'bootstrap served no default_project').toBeTruthy();

    const projects = await listProjects();
    expect(projects.length).toBeGreaterThan(1);
    if (projects[0].id === serverChoice) {
      // Nothing has been activated on this backend, so both answers coincide and
      // the assertion could not tell the fix from the bug. Fail loudly rather
      // than report a green that proves nothing.
      throw new Error(
        `Backend unfit for this test: projects[0] === default_project (${serverChoice}). ` +
          `Activate a non-@local project on the target instance first.`,
      );
    }

    // Order matters: `setContextEntityTypeId(..., null)` DELETES the localStorage
    // key (`context.ts:847`), so clearing the context after writing storage would
    // erase the very memory under test — and the assertion would then pass for the
    // wrong reason, since "no memory" also defers to the server.
    await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentProjectTypeId, null);
    // A remembered project this machine does not have.
    rememberProject(new TypeId(Project.type, '00000000-0000-4000-8000-000000000000').toString());

    await dataContext.setupProject();

    // Compare TypeIds, not raw ids: the @local project's TypeId carries the
    // `@local` uname alias rather than its uuid, so `.id` and `typeId.id` differ
    // for it and only one of them is what context actually holds.
    const landed = dataContext.getContextEntityTypeId(ContextEntitiesEnum.CurrentProjectTypeId);
    const expected = projects.find((p) => p.id === serverChoice)!;
    expect(landed?.toString(), 'a dead memory picked by list order instead of deferring').toBe(
      expected.typeId.toString(),
    );
    expect(landed?.toString()).not.toBe(projects[0].typeId.toString());
  }, 20000);

  it('still prefers the browser when the remembered project DOES resolve', async () => {
    const projects = await listProjects();
    const mine = projects.find((p) => p.id !== dataContext.bootstrapInfo?.default_project?.id);
    expect(mine, 'need a project other than the server choice').toBeTruthy();

    await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentProjectTypeId, null);
    rememberProject(mine!.typeId.toString());

    await dataContext.setupProject();

    const landed = dataContext.getContextEntityTypeId(ContextEntitiesEnum.CurrentProjectTypeId);
    expect(landed?.toString(), 'the server overrode a valid user selection').toBe(mine!.typeId.toString());
  }, 20000);
});
