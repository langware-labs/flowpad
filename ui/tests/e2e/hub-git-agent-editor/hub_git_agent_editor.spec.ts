/**
 * An agent published to git opens in the desktop's own agent editor on the hub.
 *
 *   1. DESKTOP (`HGA_BE_PORT`): a project folder linked to its hub repo; an agent in
 *      it is published — its files are pushed into the project's repo on the hub.
 *   2. HUB UI (`HGA_HUB_FE_PORT`, a hub-mode dev UI on the same hub): the owner opens
 *      `/dock/hub/assets/editor/agent/typeid/agent-<id>`. The hub reads the agent's
 *      files from git through the same SDK calls the desk uses locally, so the page is
 *      the desktop's agent editor with the published prompt in it.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const BE = `http://localhost:${process.env.HGA_BE_PORT || '6011'}`;
const HUB_FE_PORT = process.env.HGA_HUB_FE_PORT || '4100';
// The browser's origin must be `localhost`: the app calls the hub at its configured
// localhost URL, and the hub only allows that origin. Node resolves `localhost` to
// IPv6 first while Vite listens on 127.0.0.1, so Node's own calls use the address.
const HUB_FE = `http://localhost:${HUB_FE_PORT}`;
const HUB_FE_NODE = `http://127.0.0.1:${HUB_FE_PORT}`;
const HUB_EMAIL = process.env.HGA_HUB_EMAIL?.trim() ?? '';
const HUB_PASSWORD = process.env.HGA_HUB_PASSWORD ?? '';

const tag = Math.random().toString(36).slice(2, 8);
const agentName = `hubgit-agent-${tag}`;
const prompt = `You answer with the word HUBGIT${tag.toUpperCase()}.`;
const root = path.join(homedir(), 'Flowpad workspace', `hubgit-agent-${tag}`);
let projectId = '';
let agentId = '';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped JSON from the local API
async function api(method: string, p: string, body?: unknown): Promise<any> {
  const r = await fetch(`${BE}/api/v1${p}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  return r.json();
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.skip(!HUB_EMAIL || !HUB_PASSWORD, 'HGA_HUB_EMAIL / HGA_HUB_PASSWORD name the instance user on the hub');
  const bootstrap = await (await fetch(`${HUB_FE_NODE}/api/v1/graph/bootstrap`)).json();
  expect(bootstrap?.data?.supported_pages, 'HGA_HUB_FE_PORT must be a hub-mode UI').toEqual(['hub']);
  mkdirSync(root, { recursive: true });
});

test.afterAll(async () => {
  if (projectId) await api('DELETE', `/graph/project/${projectId}`).catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
});

test('1 the desktop publishes an agent into its project repo on the hub', async () => {
  const project = await api('POST', '/graph/project', {
    type: 'project',
    name: path.basename(root),
    fs_storage_mount_path: root,
  });
  projectId = project.data.id;
  const linked = await api('POST', `/graph/project/${projectId}/share`, {});
  expect(linked.status, JSON.stringify(linked).slice(0, 300)).toBe('SUCCESS');

  const agent = await api('POST', `/graph/project/${projectId}/agent`, {
    type: 'agent',
    name: agentName,
    system_prompt: prompt,
  });
  expect(agent.status, JSON.stringify(agent).slice(0, 300)).toBe('SUCCESS');
  agentId = agent.data.id;

  // The agent's own publish: commit, push into the project's hub repo, register on the hub.
  const published = await api('POST', `/graph/agent/${agentId}/publish`, { force: false });
  expect(published.status, JSON.stringify(published).slice(0, 400)).toBe('SUCCESS');
  expect(published.data?.published, JSON.stringify(published).slice(0, 400)).toBe(true);
});

test('2 the hub UI opens the agent in its editor, read from git', async ({ page }) => {
  expect(agentId, 'step 1 published an agent').not.toBe('');
  const login = await page.request.post(`${HUB_FE}/api/v1/login`, {
    data: { email: HUB_EMAIL, password: HUB_PASSWORD },
  });
  expect(login.ok(), 'the owner signs in to the hub').toBe(true);

  // The hub has the agent's files in git: its record answers with a main document.
  const refs = await page.request.get(`${HUB_FE}/api/v1/graph/agent/${agentId}/record/refs`);
  expect(refs.status(), await refs.text()).toBe(200);

  await page.goto(`${HUB_FE}/dock/hub/assets/editor/agent/typeid/agent-${agentId}`);
  await expect(page, 'the hub UI, not its login page').not.toHaveURL(/login\.html/);
  await expect(page.getByTestId('agent-definition-fields')).toBeVisible();
  await expect(page.getByTestId('asset-git-connection-required')).toHaveCount(0);
  await expect(page.getByTestId('entity-resolution-missing-asset')).toHaveCount(0);
  await expect(page.getByText(prompt, { exact: false }).first()).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('hub-agent-editor.png'), fullPage: true });
});
