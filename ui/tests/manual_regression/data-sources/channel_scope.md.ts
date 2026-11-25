/**
 * Where a new source is saved — Me or Project. The runbook is the sibling `.md`.
 *
 * Every check ends ON DISK: the `data_source.json` a click produced is looked for under the user
 * scope and under the project's folder (a git repository made here), so "saved for Me" means the
 * project's tree — and its `git status` — never saw it.
 */
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { apiContext } from '../_shared/api';

const INSTANCE = process.env.FLOW_INSTANCE || 'prod';
const FLOW_HOME = process.env.FLOW_HOME || path.join(os.homedir(), '.flow');
// A non-prod instance keeps its user-scope assets in its own instance dir (`BaseSettings.user_asset_root`).
const USER_ROOT = INSTANCE === 'prod' ? os.homedir() : path.join(FLOW_HOME, 'instances', INSTANCE, 'home');
const stamp = Date.now().toString(36);
const NAMES = {
  mine: `scope mine ${stamp}`,
  projects: `scope projects ${stamp}`,
  feed: `scope feed ${stamp}`,
  myFeed: `scope my feed ${stamp}`,
};

let api: APIRequestContext;
let mount = '';
let projectId = '';

interface Row {
  id: string;
  name: string;
  asset_ref: string;
  project_id?: string | null;
}

async function graph<T>(method: 'get' | 'post' | 'delete', route: string, data?: unknown): Promise<T> {
  const res = await api[method](`/api/v1/graph${route}`, data === undefined ? undefined : { data });
  const json = await res.json();
  expect(res.ok() && json.status === 'SUCCESS', `${method} ${route}: ${JSON.stringify(json).slice(0, 300)}`).toBeTruthy();
  return json.data as T;
}

const sourceNamed = async (name: string) => {
  let row: Row | undefined;
  await expect
    .poll(async () => (row = (await graph<Row[]>('get', '/data_source')).find((r) => r.name === name)), { message: `no source ${name}` })
    .toBeTruthy();
  return row!;
};

/** The folders under `<root>/agentic-assets/data_source/`. */
const sourcesIn = (root: string) => {
  const dir = path.join(root, 'agentic-assets', 'data_source');
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
};
const real = (p: string) => fs.realpathSync(p);
/** What git would carry of the project's sources: tracked, or added by `git add -A`. */
const gitSeesSources = () =>
  execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', 'agentic-assets/data_source'], { cwd: mount, encoding: 'utf8' }).trim();

function expectSavedForMe(row: Row) {
  expect(row.project_id ?? '', `${row.name} carries a project`).toBe('');
  expect(real(path.dirname(row.asset_ref))).toBe(real(path.join(USER_ROOT, 'agentic-assets', 'data_source')));
  expect(fs.existsSync(path.join(row.asset_ref, 'data_source.json'))).toBe(true);
}

function expectSavedInProject(row: Row) {
  expect(row.project_id).toBe(projectId);
  expect(real(path.dirname(row.asset_ref))).toBe(real(path.join(mount, 'agentic-assets', 'data_source')));
  expect(fs.existsSync(path.join(row.asset_ref, 'data_source.json'))).toBe(true);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  api = await apiContext();
  mount = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-scope-'));
  execFileSync('git', ['init', '-q'], { cwd: mount });
  projectId = (await graph<{ id: string }>('post', '/project', { name: `scope ${stamp}`, fs_storage_mount_path: mount })).id;
});

test.afterAll(async () => {
  const rows = await graph<Row[]>('get', '/data_source');
  for (const row of rows.filter((r) => Object.values(NAMES).includes(r.name))) await api.delete(`/api/v1/graph/data_source/${row.id}`);
  if (projectId) await api.delete(`/api/v1/graph/project/${projectId}`);
  fs.rmSync(mount, { recursive: true, force: true });
  await api.dispose();
});

/** Opens `route` with the test's project as the open one. */
async function open(page: Page, route: string) {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('llm-setup-modal-seen', 'true');
    } catch {
      /* sandboxed frame */
    }
  });
  await page.goto(`/dock/project/${projectId}`);
  await expect(page.getByRole('button', { name: 'Open project home' })).toContainText(`scope ${stamp}`);
  if (route) await page.goto(route);
}

const dialogTitled = (page: Page, title: RegExp) =>
  page.getByRole('dialog').filter({ has: page.getByTestId('step-crumb-0').filter({ hasText: title }) });

/** The stream inbox's "+" dialog, on Gmail's form — the one featured channel a plain form adds. */
async function channelForm(page: Page, name: string) {
  await open(page, '/dock/stream_inbox');
  await page.getByTestId('attached-channels').getByTestId('attached-channels-add').click();
  const dialog = dialogTitled(page, /^Add a channel$/);
  await dialog.getByTestId('provider-gmail').click();
  await dialog.locator('#ds-name').fill(name);
  await dialog.locator('#ds-address').fill(`${stamp}@example.com`);
  return dialog;
}

/** The Data sources screen's add dialog, on the RSS form. */
async function feedForm(page: Page, name: string) {
  await open(page, '/dock/data-sources');
  await page.getByTestId('add-data-source').click();
  const dialog = dialogTitled(page, /^Data sources$/);
  await dialog.getByTestId('provider-rss').click();
  await dialog.locator('#ds-name').fill(name);
  await dialog.locator('#ds-feed_url').fill('https://example.com/feed.xml');
  return dialog;
}

/** Presses Add and leaves the dialog, whatever setup the source goes on to. */
async function add(dialog: Locator) {
  await dialog.getByRole('button', { name: 'Add source' }).click();
  const leave = dialog.getByRole('button', { name: /^(Done|Finish later)$/ });
  await expect.poll(async () => !(await dialog.isVisible()) || (await leave.isVisible())).toBe(true);
  if (await leave.isVisible()) await leave.click();
  await expect(dialog).toBeHidden();
}

const projectTiles = (page: Page) => page.getByTestId('project-home-data-sources').getByTestId('project-source-tile');

test('1. a message channel is saved for Me, though a project is open', async ({ page }) => {
  const dialog = await channelForm(page, NAMES.mine);
  const scope = dialog.getByTestId('ds-scope');
  await expect(scope).toHaveAttribute('data-scope', 'user');
  await expect(scope.getByRole('button', { name: 'Project' }), 'no project is open').toBeEnabled();
  await add(dialog);

  expectSavedForMe(await sourceNamed(NAMES.mine));
  expect(sourcesIn(mount), "the project's folder holds a source").toEqual([]);
  expect(gitSeesSources()).toBe('');
  expect((await graph<Row[]>('get', `/project/${projectId}/data_source`)).map((r) => r.name)).not.toContain(NAMES.mine);

  // It is the person's: on their stream inbox line, not on the project's home.
  // Not signed in to Google here, so it waits on the line's attention chip rather than as a listening mark.
  await page.getByTestId('attached-channels').getByTestId('channel-warnings-chip').click();
  await expect(page.getByTestId('attached-channel-row').filter({ hasText: NAMES.mine })).toBeVisible();
  await page.keyboard.press('Escape');
  await open(page, '');
  await expect(projectTiles(page).filter({ hasText: NAMES.mine })).toHaveCount(0);
});

test('2. picked for the Project, it is saved in the project folder', async ({ page }) => {
  // A channel already added is not offered twice: the one saved for Me goes first.
  await graph('delete', `/data_source/${(await sourceNamed(NAMES.mine)).id}`);
  const dialog = await channelForm(page, NAMES.projects);
  await dialog.getByTestId('ds-scope').getByRole('button', { name: 'Project' }).click();
  await expect(dialog.getByTestId('ds-scope')).toHaveAttribute('data-scope', 'project');
  await add(dialog);

  const row = await sourceNamed(NAMES.projects);
  expectSavedInProject(row);
  expect(gitSeesSources()).toContain(path.basename(row.asset_ref));
  await open(page, '');
  await expect(projectTiles(page).filter({ hasText: NAMES.projects })).toHaveCount(1);
});

test('3. a data source starts on Project; Me keeps it out', async ({ page }) => {
  let dialog = await feedForm(page, NAMES.feed);
  await expect(dialog.getByTestId('ds-scope')).toHaveAttribute('data-scope', 'project');
  await add(dialog);
  expectSavedInProject(await sourceNamed(NAMES.feed));

  dialog = await feedForm(page, NAMES.myFeed);
  await dialog.getByTestId('ds-scope').getByRole('button', { name: 'Me' }).click();
  await add(dialog);
  const mine = await sourceNamed(NAMES.myFeed);
  expectSavedForMe(mine);
  expect(sourcesIn(mount)).not.toContain(path.basename(mine.asset_ref));

  // The source's own page says where it is saved.
  await page.goto(`/dock/data-sources/${mine.id}/settings`);
  await expect(page.getByTestId('data-source-page-scope')).toHaveText('Me');
});
