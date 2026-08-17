import { expect, test } from '@playwright/test';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const backendUrl = process.env.Q_BACKEND_URL;
const uiUrl = process.env.Q_UI_URL;
const qAvatarSource = join(process.cwd(), '..', 'agentic-assets', 'agent', 'q', 'avatar.png');

interface QFixture {
  projectId: string;
  agentId: string;
  agentPath: string;
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
    const agentPath = String(agent.data.asset_ref);
    await copyFile(qAvatarSource, join(dirname(agentPath), 'avatar.png'));
    fixture = { projectId, agentId: String(agent.data.id), agentPath, root };
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
      if (url.includes(`/graph/agent/${fixture.agentId}/fs/write/agent.md`)) standardFsWrites.push(url);
      if (url.includes(`/graph/agent/${fixture.agentId}`) && request.method() === 'PUT') entityUpdates.push(url);
    });
    await page.route(`**/api/v1/graph/agent/${fixture.agentId}/share`, async (route) => {
      expect(route.request().method()).toBe('POST');
      expect(route.request().postDataJSON()).toEqual({});
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'SUCCESS', message: 'success', data: { published: true } }),
      });
    });
    await page.addInitScript(() => localStorage.setItem('llm-setup-modal-seen', 'true'));

    await page.goto(`${uiUrl}/dock/assets/editor/agent/typeid/agent-${fixture.agentId}`);
    await page.getByTestId('asset-cloud-publish').click();
    await expect(page.getByTestId('asset-cloud-publish')).toHaveAttribute('data-state', 'published');

    await expect(page.getByLabel('Agent name')).toHaveValue('Q');
    await expect(page.getByLabel('Agent title')).toHaveValue('QA manager');
    await expect(page.getByAltText('Q avatar')).toBeVisible();

    await page.getByLabel('Agent title').fill('QA manager — cloud validated');
    await page.getByLabel('Agent title').press('Tab');
    await expect.poll(() => standardFsWrites.length).toBe(1);
    expect(entityUpdates).toEqual([]);

    const source = await readFile(fixture.agentPath, 'utf8');
    expect(source).toContain('title: QA manager — cloud validated');
    expect(source).toContain('- skill-ae32bd1d-2fca-50c2-bf33-fa24a06aad61');
    expect(source).toContain('When asked to run QA');
  });
});
