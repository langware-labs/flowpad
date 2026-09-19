/**
 * The COURSE journey, end to end across two instances via the real hub:
 *
 *   Alice mounts a git-backed course project   → git_share_preflight is `available`
 *   Alice shares it to Bob's email             → the hub grants Bob the project row
 *   Bob installs it (`setup-from-git`)         → the checkout lands in his workspace,
 *                                                READ-ONLY indexed (his clone stays clean)
 *   Bob opens /dock/project/<id> in a browser  → the dock loader redirects into the
 *                                                auto_launch agent's Vibe session, with
 *                                                its intro row and its queued prompt
 *
 * The origin is a LOCAL bare repo over `file://` — never GitHub. That is the
 * point of the share gate this pins: a `file://` origin needs no GitHub token,
 * so a `github_not_connected` refusal here is a FAILURE, not a skip.
 *
 * Requires the local hub + `scripts/instance_ctl.sh launch dev-1 && … dev-2`.
 * Skips otherwise.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Browser } from 'playwright';

import { getAliceCreds, hubAvailable, hubJson, hubLogin, localBackendIsCloudLoggedIn } from './_hub';
import { commitAndPush, makeGitWorktree } from './_git';
import { pollUntil } from './_matrix';
import {
  HUB_INST_1 as INST_1,
  HUB_INST_2 as INST_2,
  getInstance,
  instanceAvailable,
  jsonApi,
  postApi,
  type ResolvedInstance,
} from './_instances';
import { launchBrowser, openInstancePage, realConsoleErrors, resetConsoleErrors } from './_browser';
import { seedCourseProject, type SeededCourse } from './_course_fixture';
import { testEntityName } from '../_cleanup';

/** The only directory an installed project may land in — and the only one this
 *  test is ever allowed to delete from. */
const WORKSPACE = path.join(homedir(), 'Flowpad workspace');

let skipReason: string | null = null;
let alice: ResolvedInstance;
let bob: ResolvedInstance;
let aliceToken = '';
let browser: Browser | null = null;

const token = `course${randomUUID().slice(0, 8)}`;
let course: SeededCourse;
let fixtureRoot = '';
let worktree = '';
let projectId = '';
let bobMount = '';

/** Screenshots, when a run asks for evidence (`scripts/course_share_live.sh`).
 *  The journey is defined once; the live demo is this same test, watched. */
const ARTIFACTS = process.env.COURSE_LIVE_ARTIFACTS || '';
const shot = async (page: { screenshot: (o: { path: string; fullPage?: boolean }) => Promise<unknown> }, name: string) => {
  if (!ARTIFACTS) return;
  mkdirSync(ARTIFACTS, { recursive: true });
  await page.screenshot({ path: path.join(ARTIFACTS, `${name}.png`) });
};

/** `git status --porcelain` in `dir` — empty means a pull will still work. */
const porcelain = (dir: string) => execFileSync('git', ['status', '--porcelain'], { cwd: dir }).toString().trim();

beforeAll(async () => {
  const hub = await hubAvailable();
  if (!hub.ok) return void (skipReason = hub.reason ?? 'hub unreachable');
  if (!instanceAvailable(INST_1) || !instanceAvailable(INST_2)) {
    return void (skipReason = `launch ${INST_1} + ${INST_2} via scripts/instance_ctl.sh`);
  }
  alice = await getInstance(INST_1);
  bob = await getInstance(INST_2);
  for (const inst of [alice, bob]) {
    if (!(await localBackendIsCloudLoggedIn(`${inst.apiUrl}/api/v1`))) {
      return void (skipReason = `${inst.name} is not cloud-logged-in`);
    }
  }
  const creds = await getAliceCreds();
  if (!creds) return void (skipReason = 'no ALICE creds');
  aliceToken = (await hubLogin(creds.email, creds.password)).token;
}, 30_000); // do not increase timeout without approval

beforeEach((context: any) => {
  if (skipReason) {
    console.warn(`[course_project_share] skipped: ${skipReason}`);
    context.skip();
  }
});

afterAll(async () => {
  // Concurrently: three independent owners (Bob's copy, Alice's row, the hub
  // row) and the browser. Bob's `delete-with-children` tears down the live
  // auto-launched session, so serializing them does not fit the hook budget.
  await Promise.allSettled([
    browser?.close(),
    projectId && bob ? postApi(bob.apiUrl, `/graph/project/${projectId}/delete-with-children`, {}) : null,
    projectId && alice ? postApi(alice.apiUrl, `/graph/project/${projectId}/delete-with-children`, {}) : null,
    projectId && aliceToken ? hubJson(aliceToken, `/graph/project/${projectId}`, undefined, 'DELETE') : null,
  ]);
  // The receiver's checkout: only ever removed from inside the workspace, and
  // only when the install actually put it there.
  if (bobMount && path.resolve(bobMount).startsWith(`${WORKSPACE}${path.sep}`) && existsSync(bobMount)) {
    rmSync(bobMount, { recursive: true, force: true });
  }
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('course project share → install → auto-launch (two instances)', () => {
  it('Alice shares a file:// course project; Bob installs it and it opens into its agent', async () => {
    // ── Alice: a git-backed project carrying the course ──────────────────
    const fixture = makeGitWorktree('flowpad-course-share-');
    fixtureRoot = fixture.root;
    worktree = realpathSync(fixture.worktree);
    course = seedCourseProject(worktree, token);
    commitAndPush(worktree, 'course: lesson 01 + guide agent');

    const created = await postApi(alice.apiUrl, '/graph/project', {
      type: 'project',
      name: testEntityName('course'),
      fs_storage_mount_path: worktree,
    });
    projectId = created?.data?.id;
    expect(projectId, JSON.stringify(created).slice(0, 300)).toBeTruthy();

    // Index the mount so the sender holds the same rows the receiver will.
    const indexed = await postApi(alice.apiUrl, '/graph/compute_node/@local/fs-records/invalidate', {
      paths: [path.join(worktree, course.agentJsonRelPath), path.join(worktree, course.lessonRelPath)],
    });
    expect(indexed.status, JSON.stringify(indexed).slice(0, 300)).toBe('SUCCESS');
    const aliceAgent = await pollUntil(
      async () => (await jsonApi(alice.apiUrl, `/graph/agent/${course.agentId}`))?.data ?? null,
      20_000,
      'course agent indexed on alice (agent.json id adopted)',
    );
    expect(aliceAgent.auto_launch).toBe(true);

    // Indexing may stamp identity into the checkout; the preflight demands a
    // clean, pushed tree, so carry whatever it wrote before asking.
    if (porcelain(worktree)) commitAndPush(worktree, 'course: index capsules');

    // ── the share gate ───────────────────────────────────────────────────
    const pre = await jsonApi(alice.apiUrl, `/graph/project/${projectId}/git_share_preflight`);
    expect(pre.data, JSON.stringify(pre.data).slice(0, 300)).toMatchObject({ available: true, code: null });
    expect(pre.data.git_origin.provider).toBe('file');

    // A `file://` origin needs no GitHub token — the gate must let this through.
    const shared = await postApi(alice.apiUrl, `/graph/project/${projectId}/share`, { recipients: [bob.email] });
    expect(shared?.data?.code, 'the share gate must not demand GitHub for a file:// origin').not.toBe(
      'github_not_connected',
    );
    expect(shared.status, JSON.stringify(shared).slice(0, 300)).toBe('SUCCESS');

    // ── Bob: the grant arrives, then he installs ─────────────────────────
    const bobRow = await pollUntil(
      async () => {
        const r = await jsonApi(bob.apiUrl, `/graph/project/${projectId}`).catch(() => null);
        return r?.status === 'SUCCESS' && r?.data?.id ? r.data : null;
      },
      25_000,
      'shared project row on bob',
    );
    expect(bobRow.id).toBe(projectId);

    // Bob does what a student does: opens Flowpad and clicks Install. The
    // dialog is raised by the arrival watcher — a shared project is a row with
    // an origin and no files, and nothing else in the app offers to fix that.
    browser = await launchBrowser();
    const bobPage = await openInstancePage(browser, INST_2);
    await bobPage.page.evaluate(() => localStorage.setItem('llm-setup-modal-seen', 'true'));
    resetConsoleErrors(bobPage);
    await shot(bobPage.page, '01-bob-before-install');

    const dialog = bobPage.page.getByTestId('incoming-project-dialog');
    await dialog.waitFor({ state: 'visible', timeout: 30_000 });
    expect(await dialog.innerText()).toContain('shared a project with you');
    await shot(bobPage.page, '02-bob-install-offer');

    await bobPage.page.getByTestId('incoming-project-install').click();

    // Installing lands him in the project — and opening the project IS entering
    // the session, as a load-time redirect.
    await bobPage.page.waitForURL(/\/dock\/shell\/agentic_process-[0-9a-f-]+.*viewMode=vibe/, { timeout: 60_000 });
    await shot(bobPage.page, '03-bob-course-open');

    const installed = await jsonApi(bob.apiUrl, `/graph/project/${projectId}`);
    bobMount = installed.data?.fs_storage_mount_path as string;
    // The student's project keeps the name it was shared under — not the repo
    // folder's leaf, which is an implementation detail of where it was cloned.
    expect(installed.data?.name).toBe(created.data.name);
    expect(bobMount, JSON.stringify(installed.data).slice(0, 400)).toBeTruthy();
    expect(path.resolve(bobMount).startsWith(`${WORKSPACE}${path.sep}`), `installed at ${bobMount}`).toBe(true);

    // The course actually arrived on the student's disk.
    expect(existsSync(path.join(bobMount, course.lessonRelPath)), 'lesson-01.html').toBe(true);
    expect(existsSync(path.join(bobMount, course.agentJsonRelPath)), 'agent.json').toBe(true);

    // The agent is a ROW on Bob, at the sender's id, rooted in his checkout —
    // that is what auto-launch resolves when the project is opened.
    const bobAgent = await pollUntil(
      async () => (await jsonApi(bob.apiUrl, `/graph/agent/${course.agentId}`))?.data ?? null,
      20_000,
      'course agent indexed on bob',
    );
    expect(bobAgent.auto_launch).toBe(true);
    expect(realpathSync(bobAgent.asset_ref).startsWith(realpathSync(bobMount))).toBe(true);

    // The install must not dirty the clone: the student's next `git pull` for
    // the following lecture fails the moment indexing writes into it.
    expect(porcelain(bobMount), 'install left Bob a dirty checkout').toBe('');

    // ── the session Bob landed in ────────────────────────────────────────
    const page2 = bobPage;
    const intro = page2.page.getByTestId('agent-intro-message');
    await intro.first().waitFor({ state: 'visible', timeout: 30_000 });
    expect(await intro.first().innerText()).toContain(course.agentName);

    // The prompt rode the queue: still queued, or already the first user turn.
    const queued = page2.page.getByTestId('entity-execution-queue-entry').filter({ hasText: `COURSE READY ${token}` });
    const userTurn = page2.page
      .locator('[data-testid="execution-message"][data-role="user"]')
      .filter({ hasText: `COURSE READY ${token}` });
    await queued.or(userTurn).first().waitFor({ state: 'visible', timeout: 30_000 });
    await shot(page2.page, '04-bob-agent-started');

    expect(realConsoleErrors(page2.consoleErrors)).toEqual([]);

    // ── once only ────────────────────────────────────────────────────────
    const again = await postApi(bob.apiUrl, '/agents/auto-launch', { project_id: projectId });
    expect(again?.data?.error, 'auto-launch reported an error').toBeUndefined();
    expect(again?.data?.agent_id, 'a second open must not launch again').toBeNull();
  }, 120_000); // do not increase timeout without approval
});
