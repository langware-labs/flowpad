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
 * SELF-SEEDING, deliberately. The assertion needs `default_project` to differ from
 * `projects[0]`, or the fix and the bug give the same answer and a green here would
 * prove nothing. Rather than demand that of whoever runs the suite, the test builds
 * the shape itself through the real endpoints: materialize project A and ACTIVATE it
 * (so it is the most recently OPENED), then materialize project B and leave it alone
 * (so it is the most recently UPDATED, which is what this query sorts by), then
 * re-bootstrap to pick up the recomputed `default_project`.
 *
 * That split is the reported incident in miniature: a background git scan kept
 * bumping `my_first_project`'s row while the user's actual project sat untouched for
 * two days, so "most recently updated" and "where the user was" pointed at different
 * projects.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ActionInfo, ContextEntitiesEnum, dataContext, dataManager, Project, QueryRequest, TypeId, User } from '@sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';
import { installCleanup, testEntityName, trackTypeId } from '../_cleanup';

// This file CREATES REAL PROJECTS on the target backend to build its fixture, so it
// opts into the cleanup registry the headless/hub tiers use. The api tier installs a
// leak tripwire only (`apiSetup.ts`), on the assumption that api tests write to a
// temp-isolated records root — `materialize-project` breaks that assumption: it
// writes into the real workspace and the real DB. Untracked, these piled up.
installCleanup({ sweepTypes: ['project'] });

/**
 * FAIL CLOSED on the target backend. This file materializes REAL projects, so an
 * unintended target is not a wrong assertion — it is writing into someone's live
 * instance. That is not hypothetical: on 2026-08-18 this tier resolved to the
 * desktop app (`LOCAL_SERVER_PORT=9007` exported in the shell beats `.env.local`
 * in vite's `loadEnv`) and test projects landed in it.
 *
 * Two checks, because either alone is insufficient:
 *   1. an instance must be NAMED — `.env.local` is never a live-test fallback
 *      (the same rule `tests/react/reactSetup.ts:17` enforces for its tier);
 *   2. the backend must AGREE it is that instance — the name is a request, the
 *      bootstrap payload is what actually answered, and step 1 cannot catch a
 *      config that silently points elsewhere.
 */
const SELECTED_INSTANCE = process.env.FLOW_INSTANCE?.trim() || '';
if (!SELECTED_INSTANCE) {
  throw new Error(
    'setup_project_stale_memory requires FLOW_INSTANCE=<disposable-name>: it creates real ' +
      'projects, and `.env.local` is never a live-test fallback',
  );
}

/** Refuse a backend that is not the disposable one that was asked for. */
function assertDisposableTarget(): void {
  const served = dataContext.bootstrapInfo?.env?.instance_name as string | undefined;
  if (served !== SELECTED_INSTANCE) {
    throw new Error(
      `refusing to create projects: asked for instance '${SELECTED_INSTANCE}' but the backend ` +
        `reports '${served ?? 'unknown'}' — check VITE_API_URL and any exported LOCAL_SERVER_PORT`,
    );
  }
}

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

/** Materialize a project on the @local compute node through the real action. */
async function materialize(kind: string): Promise<string> {
  const cnId = dataContext.bootstrapInfo?.default_compute_node?.id as string;
  // `e2etest-…` names, so the leak sweep can find anything the registry misses.
  const name = testEntityName(kind);
  const staging = path.join(os.tmpdir(), `${name}`);
  mkdirSync(staging, { recursive: true });
  writeFileSync(path.join(staging, 'README.md'), `# ${name}\n`);
  const info = new ActionInfo('materialize-project', 'compute_node', cnId, 'POST');
  // The body rides on the ActionInfo — `callAction` takes no payload argument.
  info.bodyParameters = { staging_path: staging, name };
  const res = await dataManager.callAction<never, { project: { id: string } }>(info);
  // Registered for teardown: the project is reached via a raw action rather than an
  // entity handle, so `trackTypeId` is the seam rather than `trackForCleanup`.
  trackTypeId(Project.type, res.project.id);
  return res.project.id;
}

/**
 * Build "opened last" and "touched last" as two DIFFERENT projects, and return the
 * one the server should choose. Re-bootstraps so `bootstrapInfo.default_project`
 * reflects the activation — it is stamped per-caller, so a fresh call recomputes it.
 */
async function seedDivergentProjects(): Promise<string> {
  const opened = await materialize('opened-last');
  // `Project.activateById` is what the product posts on every project switch
  // (`context.ts:846`), so the recency stamp is made the same way the real app
  // makes it rather than by a hand-built request.
  await Project.activateById(opened);
  await materialize('touched-last');
  dataContext.bootstrapInfo = await dataManager.bootstrap(window.location.hostname, true);
  return opened;
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
    assertDisposableTarget();
    const bootUser = dataContext.bootstrapInfo?.user;
    expect(bootUser, 'bootstrap served no @local user').toBeTruthy();
    const user = new User(bootUser);
    user.markAsExpanded();
    await dataContext.setContextEntityTypeId(ContextEntitiesEnum.LocalUserTypeId, user.typeId);
  });

  it('defers to the server rather than grabbing the first project on the list', async () => {
    const serverChoice = await seedDivergentProjects();
    expect(dataContext.bootstrapInfo?.default_project?.id).toBe(serverChoice);

    const projects = await listProjects();
    expect(projects.length).toBeGreaterThan(1);
    // The seeding above is what makes this assertion meaningful; if the two ever
    // coincide the test can no longer tell the fix from the bug, so say so loudly
    // rather than report a green that proves nothing.
    expect(projects[0].id, 'seeding failed: projects[0] === default_project').not.toBe(serverChoice);

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
    // Seeds its own project rather than reusing whatever the instance happens to
    // hold, so this case does not depend on the other test having run first — the
    // order-dependence trap this ticket already tripped over once.
    const serverChoice = await seedDivergentProjects();
    const mineId = await materialize('my-own-pick');
    const projects = await listProjects();
    const mine = projects.find((p) => p.id === mineId);
    expect(mine, 'seeded project missing from the list').toBeTruthy();
    expect(mineId, 'seeded project must differ from the server choice').not.toBe(serverChoice);

    await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentProjectTypeId, null);
    rememberProject(mine!.typeId.toString());

    await dataContext.setupProject();

    const landed = dataContext.getContextEntityTypeId(ContextEntitiesEnum.CurrentProjectTypeId);
    expect(landed?.toString(), 'the server overrode a valid user selection').toBe(mine!.typeId.toString());
  }, 20000);
});
