/**
 * Browser scenario — a project's home page: `home_page` in the project manifest
 * (`agentic-assets/project_manifest/project_manifest.json`).
 *
 *   1. Configure: pick the project's agent in Customize → Home → Home page (the
 *      shared asset picker). Home then lands in the agent's chat in Vibe; Home
 *      from there steps off to the default home; Home again RESUMES the same
 *      chat. Only Home lands there — opening the project stays on its page.
 *   2. Deleting: resetting the setting, or deleting the agent it names, means
 *      Home no longer lands anywhere but the default home.
 *   3. Malformed: a manifest naming an unknown type, a bad id, or neither, or a
 *      manifest that is not JSON — Home and the Customize card keep working, no
 *      page error.
 *   4. Foreign: an agent belonging to ANOTHER project is not offered by the
 *      picker, refused by `set-home-page`, and not honoured when written into
 *      the manifest by hand.
 *
 * Seeding uses the HTTP graph API; malformed and foreign declarations are
 * written straight into the project's manifest, the way a cloned repo would
 * carry them.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const BE = `http://localhost:${process.env.HP_BE_PORT || '6001'}`;
const GRAPH = `${BE}/api/v1/graph`;
const SESSION_URL = /\/dock\/shell\/agentic_process-([0-9a-f-]+).*viewMode=vibe/;

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

/** On a default home: the root, not a session — and the app is still rendered. */
async function expectDefaultHome(page: Page) {
  await expect(page).not.toHaveURL(/\/dock\/shell\//);
  await expect(page).toHaveURL(/\/(\?|$)/);
  await expect(page.getByTestId('top-nav-home')).toBeVisible();
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
    await expect(agentRow).toBeVisible({ timeout: 60_000 });
    await agentRow.click();
    await expect(picker).toContainText(homeAgent.title);

    // The choice is the manifest, naming the agent's TypeId.
    await expect.poll(declaredHomePage).toBe(`agent-${homeAgent.id}`);

    // And Home honours it.
    await clickHome(page);
    await expect(page).toHaveURL(SESSION_URL);

    declare(null);
    expect(errors).toEqual([]);
  });

  test('Home lands on the home agent chat in Vibe, steps off it, and resumes it', async ({ page }) => {
    const errors = collectPageErrors(page);
    declare(`agent-${homeAgent.id}`);
    await page.goto(projectHomeUrl(home.id));
    await expect(page.getByTestId('top-nav-home')).toBeVisible();

    // 2. Home → the agent's chat, in Vibe.
    await clickHome(page);
    await expect(page).toHaveURL(SESSION_URL);
    const firstProcess = SESSION_URL.exec(page.url())?.[1];
    expect(firstProcess).toBeTruthy();

    // 3. Home from the home page itself → the default home (the way out).
    await clickHome(page);
    await expectDefaultHome(page);

    // 4. Home again → the SAME chat, resumed rather than a new one.
    await clickHome(page);
    await expect(page).toHaveURL(SESSION_URL);
    expect(SESSION_URL.exec(page.url())?.[1]).toBe(firstProcess);

    // 5. Only Home lands there: opening the project stays on the project page,
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
    // Opening the project no longer redirects either.
    await page.goto(`/dock/project/${home.id}`);
    await expect(page).toHaveURL(new RegExp(`/dock/project/${home.id}`));

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
      await page.goto(`/dock/project/${home.id}`);
      await expect(page).toHaveURL(new RegExp(`/dock/project/${home.id}`));

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
      timeout: 60_000,
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
    await page.goto(`/dock/project/${home.id}`);
    await expect(page).toHaveURL(new RegExp(`/dock/project/${home.id}`));

    declare(null);
    expect(errors).toEqual([]);
  });
});
