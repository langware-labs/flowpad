/**
 * Browser scenario — a project's home page: `home_page` in the project manifest
 * (`agentic-assets/project_manifest/project_manifest.json`).
 *
 *   1. Configure: pick the project's agent in Customize → Home → Home page (the
 *      shared asset picker). Launching the project then lands in the agent's
 *      chat in Vibe; the Home button steps off to Flowpad's home; launching
 *      again RESUMES the same chat. Only a launch lands there — the project page
 *      itself (no ask) stays on its page.
 *   2. Deleting: resetting the setting, or deleting the agent it names, means
 *      a launch lands nowhere but the project page, and Home on the default home.
 *   3. Malformed: a manifest naming an unknown type, a bad id, or neither, or a
 *      manifest that is not JSON — a launch, Home and the Customize card keep
 *      working, no page error.
 *   4. Foreign: an agent belonging to ANOTHER project is not offered by the
 *      picker, refused by `set-home-page`, and not honoured when written into
 *      the manifest by hand.
 *
 * Seeding uses the HTTP graph API; malformed and foreign declarations are
 * written straight into the project's manifest, the way a cloned repo would
 * carry them.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { adjusted } from '../../adjustableTimeout';

const BE = `http://localhost:${process.env.HP_BE_PORT || '6001'}`;
const GRAPH = `${BE}/api/v1/graph`;
// A session shown in Vibe is its Vibe HOST tab: `/dock/vibe/agentic_process-<id>`.
const SESSION_URL = /\/dock\/vibe\/agentic_process-([0-9a-f-]+)/;

interface Seeded {
  id: string;
  root: string;
}

let home: Seeded; // the project under test
let foreign: Seeded; // another project, whose agent must never be home here
let homeAgent = { id: '', title: '' };
let foreignAgent = { id: '', title: '' };

async function post(url: string, body?: unknown): Promise<any> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  return r.json();
}

async function seedProject(name: string): Promise<Seeded> {
  const created = await post(`${GRAPH}/project`, { type: 'project', name });
  const id = created?.data?.id;
  if (!id) throw new Error(`project create failed: ${JSON.stringify(created).slice(0, 200)}`);
  const row = await (await fetch(`${GRAPH}/project/${id}`)).json();
  const root = row?.data?.fs_storage_mount_path;
  if (!root) throw new Error(`project ${id} has no folder`);
  return { id, root };
}

async function seedAgent(projectId: string, title: string): Promise<{ id: string; title: string }> {
  const res = await post(`${GRAPH}/project/${projectId}/agent`, { type: 'agent', name: title, title });
  if (res?.status !== 'SUCCESS') throw new Error(`agent create failed: ${JSON.stringify(res).slice(0, 300)}`);
  return { id: res.data.id, title };
}

const manifestDir = (root: string) => join(root, 'agentic-assets', 'project_manifest');
const manifestFile = (root: string) => join(manifestDir(root), 'project_manifest.json');

/** The manifest as a document, or null when absent or not JSON. */
function readManifest(root: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(manifestFile(root), 'utf8'));
  } catch {
    return null;
  }
}

/** The home page the manifest declares (`undefined` when the key is absent). */
const declaredHomePage = () => readManifest(home.root)?.home_page;

/** Write the manifest's raw bytes — for a manifest that is not even JSON. */
function writeManifestText(text: string): void {
  mkdirSync(manifestDir(home.root), { recursive: true });
  writeFileSync(manifestFile(home.root), text, 'utf8');
  // The card reads the indexed ProjectManifest row, which nothing watches the file for:
  // index it the way the machine indexes a changed asset folder (`flow record index`).
  execFileSync(
    'curl',
    ['-s', '-X', 'POST', '--max-time', '20', `${GRAPH}/compute_node/@local/fs-records/index?${new URLSearchParams({ type: 'project_manifest', path: manifestDir(home.root) })}`],
    { stdio: 'ignore' },
  );
}

/**
 * Declare the home page by hand, into the manifest — what a cloned repo
 * carries. Merges into the existing ledger (its published rows are not ours to
 * drop); `null` removes the key. An unreadable manifest is replaced by a valid
 * one, so a malformed case cannot leak into the next test.
 */
function declare(homePage: unknown): void {
  const file = manifestFile(home.root);
  const current = readManifest(home.root) ?? { schema: 1, requires: {}, entries: [] };
  if (homePage === null) {
    if (!existsSync(file)) return;
    delete current.home_page;
  } else {
    current.home_page = homePage;
  }
  writeManifestText(`${JSON.stringify(current, null, 2)}\n`);
}

const projectHomeUrl = (projectId: string) =>
  `/dock/assets/project-home?scope-mode=project&scope-activeProjectId=${projectId}`;

/** Every uncaught page error, so "does not break" is asserted, not eyeballed. */
function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

async function openCustomize(page: Page, projectId: string) {
  await page.goto(projectHomeUrl(projectId));
  await page.getByTestId('project-home-tab-customize').click();
  const card = page.getByTestId('home-customization-card');
  await expect(card).toBeVisible();
  return card;
}

async function clickHome(page: Page) {
  await page.getByTestId('top-nav-home').click();
}

/** Launch the project the way picking or opening one does: its dock, asking for the home page
 *  (`withHomePage(DockPointer.forProject(id))`). The Home button no longer asks (4380657ba): it is
 *  Flowpad's own home. */
async function launchProject(page: Page, projectId: string) {
  await page.goto(`/dock/project/${projectId}?homePage=open`);
}

/** On a default home: the root, not a session — and the app is still rendered. */
async function expectDefaultHome(page: Page) {
  await expect(page).not.toHaveURL(/\/dock\/(shell|vibe)\//);
  await expect(page).toHaveURL(/\/(\?|$)/);
  // On the home the bar's Home slot reads "Back to tabs" while tabs are open.
  await expect(page.getByTestId('top-nav-home').or(page.getByTestId('top-nav-tabs'))).toBeVisible();
}

/** Launch the project when it has no home page to land on: it stays on the project page. The URL starts
 *  on the project, so it alone passes before the load decides. The router renders nothing until the
 *  load's redirects are decided (HydrateFallback), so the project page on screen means none was taken. */
async function expectLaunchStaysOnProjectPage(page: Page, projectId: string) {
  await launchProject(page, projectId);
  await expect(page.getByTestId('project-home-tabs')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/dock/project/${projectId}`));
}

test.beforeAll(async () => {
  try {
    const h = await fetch(`${BE}/api/v1/health/status`, { signal: AbortSignal.timeout(2000) });
    if (!h.ok) throw new Error('unhealthy');
  } catch {
    test.skip(true, `backend not up on ${BE} — launch the build under test first`);
  }
  const stamp = Date.now();
  home = await seedProject(`hp-e2e-${stamp}`);
  foreign = await seedProject(`hp-e2e-foreign-${stamp}`);
  homeAgent = await seedAgent(home.id, `Home Agent ${stamp}`);
  foreignAgent = await seedAgent(foreign.id, `Foreign Agent ${stamp}`);
});

test.afterAll(async () => {
  for (const project of [home, foreign]) {
    try {
      if (project?.id) await post(`${GRAPH}/project/${project.id}/delete-with-children`);
    } catch {
      /* best effort */
    }
  }
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('llm-setup-modal-seen', 'true');
  });
});

// Each test sets its own declaration, so they run independently (one worker,
// in file order): a broken picker must not hide whether Home itself works.
test.describe('project home page', () => {
  test('configure the home agent in Customize through the asset picker', async ({ page }) => {
    const errors = collectPageErrors(page);
    declare(null);

    const card = await openCustomize(page, home.id);
    const picker = card.getByTestId('home-page-picker');
    await expect(picker).toContainText('Default home');
    await picker.click();
    const popover = page.getByTestId('asset-manager-popover');
    await expect(popover).toBeVisible();
    const agentRow = popover.locator(`[data-testid^="asset-manager-select-agent-${homeAgent.id}-"]`).first();
    // The picker's list is a live backend scan of the project, and the first
    // one for a project created seconds ago can take well past 20s.
    await expect(agentRow).toBeVisible({ timeout: adjusted(60_000) });
    await agentRow.click();
    await expect(picker).toContainText(homeAgent.title);

    // The choice is the manifest, naming the agent's TypeId.
    await expect.poll(declaredHomePage).toBe(`agent-${homeAgent.id}`);

    // And launching the project honours it.
    await launchProject(page, home.id);
    await expect(page).toHaveURL(SESSION_URL);

    declare(null);
    expect(errors).toEqual([]);
  });

  test('a web app home: the project opens app-first, on the app running', async ({ page }) => {
    const errors = collectPageErrors(page);
    declare(null);
    // A static web app in the project — `webapp.json` naming its build folder, a page in it.
    const appName = `hp-app-${Date.now()}`;
    const appDir = join(home.root, 'agentic-assets', 'webapp', appName);
    mkdirSync(join(appDir, 'build'), { recursive: true });
    writeFileSync(join(appDir, 'webapp.json'), JSON.stringify({ name: appName, title: appName, build: 'build' }));
    writeFileSync(
      join(appDir, 'build', 'index.html'),
      `<!doctype html><title>${appName}</title><h1 data-testid="app-first-title">${appName}</h1>`,
    );

    // Indexed the way the machine indexes a new asset folder (`flow record index`).
    const indexed = await post(
      `${GRAPH}/compute_node/@local/fs-records/index?${new URLSearchParams({ type: 'micro_app', path: appDir })}`,
    );
    const appTypeId = String(indexed?.data?.typeid ?? indexed?.typeid ?? '');
    expect(appTypeId).toMatch(/^micro_app-[0-9a-f-]{36}$/);

    // Picked like any home page: the picker offers web apps.
    const card = await openCustomize(page, home.id);
    const picker = card.getByTestId('home-page-picker');
    await picker.click();
    const popover = page.getByTestId('asset-manager-popover');
    await expect(popover).toBeVisible();
    const appRow = popover.locator(`[data-testid^="asset-manager-select-${appTypeId}-"]`).first();
    await expect(appRow).toBeVisible({ timeout: adjusted(60_000) });
    await appRow.click();
    await expect(picker).toContainText(appName);
    await expect.poll(declaredHomePage).toBe(appTypeId);

    // Launching the project lands on the app RUNNING, pinned to the project — and the app is not handed the scope.
    await launchProject(page, home.id);
    await expect(page).toHaveURL(new RegExp(`/dock/app/${appTypeId}\\?.*scope-activeProjectId=${home.id}`));
    const frame = page.frameLocator('[data-testid="vibe-app-frame"]');
    await expect(frame.getByTestId('app-first-title')).toHaveText(appName, { timeout: adjusted(30_000) });
    const src = await page.getByTestId('vibe-app-frame').first().getAttribute('src');
    expect(src ?? '').not.toContain('scope-');

    // Every launch asks for the home page: the app again.
    await launchProject(page, home.id);
    await expect(page).toHaveURL(new RegExp(`/dock/app/${appTypeId}\\?.*scope-activeProjectId=${home.id}`));
    // The Home button is Flowpad's home, never the project's home page.
    await clickHome(page);
    await expectDefaultHome(page);
    await page.goto('/');
    await expectDefaultHome(page);
    const reloaded = await openCustomize(page, home.id);
    await expect(reloaded.getByTestId('home-page-picker')).toContainText(appName);

    declare(null);
    expect(errors).toEqual([]);
  });

  test('Home lands on the home agent chat in Vibe, steps off it, and resumes it', async ({ page }) => {
    const errors = collectPageErrors(page);
    declare(`agent-${homeAgent.id}`);
    await page.goto(projectHomeUrl(home.id));
    await expect(page.getByTestId('top-nav-home')).toBeVisible();

    // 2. Launching the project → the agent's chat, in Vibe.
    await launchProject(page, home.id);
    await expect(page).toHaveURL(SESSION_URL);
    const firstProcess = SESSION_URL.exec(page.url())?.[1];
    expect(firstProcess).toBeTruthy();

    // 3. The Home button steps off the chat to Flowpad's home (it never asks for the project's home page).
    await clickHome(page);
    await expectDefaultHome(page);

    // 4. Launching the project again → the SAME chat, resumed rather than a new one.
    await launchProject(page, home.id);
    await expect(page).toHaveURL(SESSION_URL);
    expect(SESSION_URL.exec(page.url())?.[1]).toBe(firstProcess);

    // 5. Only a launch lands there: the project page without the ask stays on the project page,
    //    where the home page is configured.
    await page.goto(`/dock/project/${home.id}`);
    await expect(page).toHaveURL(new RegExp(`/dock/project/${home.id}`));

    declare(null);
    expect(errors).toEqual([]);
  });

  test('deleting the setting: Home goes back to the default home', async ({ page }) => {
    const errors = collectPageErrors(page);
    declare(`agent-${homeAgent.id}`);

    const card = await openCustomize(page, home.id);
    await expect(card.getByTestId('home-page-picker')).toContainText(homeAgent.title);
    await card.getByTestId('home-page-reset').click();
    await expect(card.getByTestId('home-page-picker')).toContainText('Default home');
    // Cleared means the key is GONE, not null: an older desk rejects unknown keys.
    await expect.poll(() => readManifest(home.root) !== null && !('home_page' in readManifest(home.root)!)).toBe(true);

    await clickHome(page);
    await expectDefaultHome(page);
    // Launching the project no longer lands on the agent's chat.
    await expectLaunchStaysOnProjectPage(page, home.id);

    expect(errors).toEqual([]);
  });

  test('deleting the agent it names: Home goes back to the default home', async ({ page }) => {
    const errors = collectPageErrors(page);
    const doomed = await seedAgent(home.id, `Doomed Agent ${Date.now()}`);
    declare(`agent-${doomed.id}`);
    await fetch(`${GRAPH}/agent/${doomed.id}`, { method: 'DELETE', signal: AbortSignal.timeout(20_000) });

    const payload = await (await fetch(`${GRAPH}/project/${home.id}/home-page`)).json();
    expect(payload?.data?.asset).toBeNull();

    const card = await openCustomize(page, home.id);
    await expect(card.getByTestId('home-page-picker')).toContainText('Missing asset');
    await clickHome(page);
    await expectDefaultHome(page);
    // Launching the project does not bring the deleted agent back.
    await expectLaunchStaysOnProjectPage(page, home.id);

    declare(null);
    expect(errors).toEqual([]);
  });

  for (const [label, write] of [
    ['an unknown type with a valid id', () => declare(`nosuchtype-${randomUUID()}`)],
    ['a known type with a bad id', () => declare('agent-not-a-uuid')],
    ['an unknown type and a bad id', () => declare('nosuchtype-not-a-uuid')],
    ['a manifest that is not JSON', () => writeManifestText('{ "home_page": ')],
  ] as const) {
    test(`malformed — ${label}: Home and the Customize card keep working`, async ({ page }) => {
      const errors = collectPageErrors(page);
      write();

      const payload = await (await fetch(`${GRAPH}/project/${home.id}/home-page`)).json();
      expect(payload?.status).toBe('SUCCESS');
      expect(payload?.data?.asset).toBeNull();

      const card = await openCustomize(page, home.id);
      await expect(card.getByTestId('home-page-picker')).toBeVisible();
      await clickHome(page);
      await expectDefaultHome(page);
      // Launching the project reads the declaration and still opens the project page.
      await expectLaunchStaysOnProjectPage(page, home.id);

      declare(null);
      expect(errors).toEqual([]);
    });
  }

  test("another project's agent is not offered by the picker", async ({ page }) => {
    const errors = collectPageErrors(page);
    declare(null);

    // The picker lists this project's agent (so the list is real), never the other's.
    const card = await openCustomize(page, home.id);
    await card.getByTestId('home-page-picker').click();
    const popover = page.getByTestId('asset-manager-popover');
    await expect(popover.locator(`[data-testid^="asset-manager-select-agent-${homeAgent.id}-"]`).first()).toBeVisible({
      timeout: adjusted(60_000),
    });
    await expect(popover.locator(`[data-testid^="asset-manager-select-agent-${foreignAgent.id}-"]`)).toHaveCount(0);

    expect(errors).toEqual([]);
  });

  test("another project's agent is refused by set-home-page", async () => {
    declare(null);
    const res = await post(`${GRAPH}/project/${home.id}/set-home-page`, { typeid: `agent-${foreignAgent.id}` });
    expect(res?.status).not.toBe('SUCCESS');
    // Refused means untouched: no home page was written.
    expect(declaredHomePage()).toBeUndefined();
  });

  test("another project's agent written into the manifest is not honoured", async ({ page }) => {
    const errors = collectPageErrors(page);
    declare(`agent-${foreignAgent.id}`);
    const payload = await (await fetch(`${GRAPH}/project/${home.id}/home-page`)).json();
    expect(payload?.data?.asset).toBeNull();

    await page.goto(projectHomeUrl(home.id));
    await clickHome(page);
    await expectDefaultHome(page);
    // Launching the project does not open the other project's agent.
    await expectLaunchStaysOnProjectPage(page, home.id);

    declare(null);
    expect(errors).toEqual([]);
  });
});
