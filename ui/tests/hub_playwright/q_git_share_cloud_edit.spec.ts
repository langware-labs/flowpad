import { expect, test } from '@playwright/test';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const backendUrl = process.env.Q_BACKEND_URL;
const uiUrl = process.env.Q_UI_URL;
const qAvatarSource = join(process.cwd(), '..', 'agentic-assets', 'agent', 'q', 'avatar.png');

interface QFixture {
  projectId: string;
  agentId: string;
  /** The agent's asset folder: ``agent.json`` + ``system_prompt.md`` (b37cba70e, 2026-09-16). */
  agentDir: string;
  root: string;
}

async function graph(path: string, init?: RequestInit) {
  if (!backendUrl) throw new Error('Q_BACKEND_URL is required');
  const response = await fetch(`${backendUrl}/api/v1/graph/${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  if (!response.ok)
    throw new Error(`${init?.method ?? 'GET'} ${path} failed: ${response.status} ${await response.text()}`);
  return (await response.json()) as { data: Record<string, unknown> };
}

test.describe('Q publish and cloud asset-editor flow', () => {
  let fixture: QFixture;

  test.beforeAll(async () => {
    if (!uiUrl || !backendUrl) throw new Error('Q_UI_URL and Q_BACKEND_URL are required');
    const root = await mkdtemp(join(tmpdir(), 'flowpad-q-browser-'));
    const project = await graph('project', {
      method: 'POST',
      body: JSON.stringify({ type: 'project', name: 'flowpad-os', fs_storage_mount_path: root }),
    });
    const projectId = String(project.data.id);
    const agent = await graph(`project/${projectId}/agent`, {
      method: 'POST',
      body: JSON.stringify({
        type: 'agent',
        name: 'Q',
        title: 'QA manager',
        description: "Flowpad's QA manager for evidence-driven end-to-end validation.",
        avatar: './avatar.png',
        skills: ['skill-ae32bd1d-2fca-50c2-bf33-fa24a06aad61'],
        system_prompt: 'When asked to run QA, use the `e2e-qa` skill.',
      }),
    });
    const agentDir = String(agent.data.asset_ref);
    await copyFile(qAvatarSource, join(agentDir, 'avatar.png'));
    fixture = { projectId, agentId: String(agent.data.id), agentDir, root };
  });

  test.afterAll(async () => {
    if (!fixture) return;
    await graph(`agent/${fixture.agentId}`, { method: 'DELETE' }).catch(() => undefined);
    await graph(`project/${fixture.projectId}`, { method: 'DELETE' }).catch(() => undefined);
    await rm(fixture.root, { recursive: true, force: true });
  });

  test('publishes Q, renders its profile/avatar, and saves through entity VFS', async ({ page }) => {
    const standardFsWrites: string[] = [];
    const entityUpdates: string[] = [];
    page.on('request', (request) => {
      const url = request.url();
      // The editor saves the agent's own file through the revision-safe document
      // route (8ad402638); the fields live in agent.json, not agent.md frontmatter.
      if (url.includes(`/graph/agent/${fixture.agentId}/fs/document/agent.json`) && request.method() === 'POST')
        standardFsWrites.push(url);
      if (url.includes(`/graph/agent/${fixture.agentId}`) && request.method() === 'PUT') entityUpdates.push(url);
    });
    // The hub push is stubbed; its answer is not. The real ``share`` action
    // answers with the canonical entity, now ``remote`` — the ONLY thing the
    // button derives "published" from (``CloudAssetPublishButton``; the SDK's
    // ``adoptShareResponse`` refuses to manufacture ``remote`` from a receipt).
    // A bare ``{published: true}`` receipt left the button "local" forever.
    const canonical = (await graph(`agent/${fixture.agentId}`)).data;
    await page.route(`**/api/v1/graph/agent/${fixture.agentId}/share`, async (route) => {
      expect(route.request().method()).toBe('POST');
      expect(route.request().postDataJSON()).toEqual({});
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'SUCCESS', message: 'success', data: { ...canonical, remote: true } }),
      });
    });
    await page.addInitScript(() => localStorage.setItem('llm-setup-modal-seen', 'true'));

    await page.goto(`${uiUrl}/dock/assets/editor/agent/typeid/agent-${fixture.agentId}`);
    await page.getByTestId('asset-cloud-publish').click();
    await expect(page.getByTestId('asset-cloud-publish')).toHaveAttribute('data-state', 'published');

    // The profile header is title + avatar: the editable name field left the
    // editor with "Agent page: a shared Definition…" (0b6e0030e, 2026-09-14),
    // and the avatar's alt text is the DISPLAY name (the title), not ``name``.
    await expect(page.getByLabel('Agent title')).toHaveValue('QA manager');
    const avatar = page.getByRole('button', { name: 'Change avatar' }).getByRole('img');
    await expect(avatar).toBeVisible();
    await expect(avatar).toHaveAttribute('alt', 'QA manager avatar');
    await expect(avatar).toHaveAttribute('src', /avatar\.png/);
    await expect.poll(() => avatar.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);

    await page.getByLabel('Agent title').fill('QA manager — cloud validated');
    await page.getByLabel('Agent title').press('Tab');
    await expect.poll(() => standardFsWrites.length).toBe(1);
    expect(entityUpdates).toEqual([]);

    const spec = JSON.parse(await readFile(join(fixture.agentDir, 'agent.json'), 'utf8'));
    expect(spec.title).toBe('QA manager — cloud validated');
    expect(spec.skills).toContain('skill-ae32bd1d-2fca-50c2-bf33-fa24a06aad61');
    expect(await readFile(join(fixture.agentDir, 'system_prompt.md'), 'utf8')).toContain('When asked to run QA');
  });
});
