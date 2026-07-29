/**
 * Deterministic browser coverage for the Vibe Workspace matrix.
 * Source: vibe_workspace_matrix.md
 *
 * Natural-language creation/run quality remains a live-Claude matrix. These
 * tests guard the product-owned rails beneath it: canonical workspace routing,
 * one-tab identity, `flow show` target rendering/history/restore, and the
 * project-local skill/image viewers. They require no model response.
 */
import { expect, test } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';

import { API, createVibeFixture, destroyVibeFixture, openVibe, showPath, showPort, showTypeId } from './_helpers';

test.describe('Claude Vibe Workspace browser matrix', () => {
  test('VW-01/VW-15: legacy display links canonicalize to one shell workspace tab', async ({ page, request }) => {
    const fixture = await createVibeFixture(request, 'vibe-entry');
    try {
      await page.addInitScript(() => localStorage.setItem('llm-setup-modal-seen', 'true'));
      await page.goto(`/dock/display/agentic_process-${fixture.processId}?viewMode=vibe&matrix=legacy`);

      await expect(page).toHaveURL(new RegExp(`/dock/shell/agentic_process-${fixture.processId}\\?.*viewMode=vibe`));
      expect(new URL(page.url()).searchParams.get('matrix')).toBe('legacy');
      await expect(page.locator('[data-testid="entity-execution-new"]:visible')).toBeVisible();
      await expect(page.getByTestId('workspace-display-tab')).toHaveAttribute('aria-current', 'true');
      await expect(page.getByTestId('view-toggle-vibe')).toHaveAttribute('aria-checked', 'true');

      const tabsResponse = await request.get(`${API}/api/v1/graph/tab/list_all`);
      expect(tabsResponse.status()).toBe(200);
      const tabs = (await tabsResponse.json()).data?.tabs ?? [];
      const processTabs = tabs.filter((tab: { target_id?: string }) => tab.target_id === fixture.processId);
      expect(processTabs).toHaveLength(1);
      expect(processTabs[0].parent_tab_id ?? null).toBeNull();
      const processPointer =
        processTabs[0].pointer ??
        processTabs[0].dock_pointer ??
        processTabs[0].dockPointer;
      expect(JSON.stringify(processPointer)).toContain('shell');
      expect(JSON.stringify(processPointer)).not.toContain('display');
    } finally {
      await destroyVibeFixture(request, fixture);
    }
  });

  test('VW-02/VW-03/VW-07/VW-14: shown files render, history is newest-first, and Display restores', async ({
    page,
    request,
  }) => {
    const fixture = await createVibeFixture(request, 'vibe-display-files');
    try {
      const docs = path.join(fixture.root, 'docs');
      const publicDir = path.join(fixture.root, 'public');
      mkdirSync(docs, { recursive: true });
      mkdirSync(publicDir, { recursive: true });
      const markdownPath = path.join(docs, 'open-me.md');
      const htmlPath = path.join(publicDir, 'open-me.html');
      writeFileSync(markdownPath, '# VW02_MARKDOWN_READY\n', 'utf8');
      writeFileSync(
        htmlPath,
        '<!doctype html><button id="activate" onclick="this.textContent=\'VW03_HTML_CLICKED\'">VW03_HTML_READY</button>',
        'utf8',
      );

      await showPath(request, fixture.processId, markdownPath);
      await showPath(request, fixture.processId, htmlPath);
      await openVibe(page, fixture.processId);

      const htmlPreview = page.getByTestId('html-preview');
      await expect(htmlPreview).toBeVisible();
      const htmlFrame = page.frameLocator('[data-testid="html-preview"]');
      await expect(htmlFrame.locator('#activate')).toHaveText('VW03_HTML_READY');
      await htmlFrame.locator('#activate').click();
      await expect(htmlFrame.locator('#activate')).toHaveText('VW03_HTML_CLICKED');

      await page.getByTestId('display-history').click();
      const history = page.getByTestId('display-history-row');
      await expect(history).toHaveCount(2);
      await expect(history.nth(0)).toContainText('open-me.html');
      await expect(history.nth(1)).toContainText('open-me.md');
      await history.nth(1).click();
      await expect(page).toHaveURL(/\/dock\/assets\/editor\/markdown\//);
      await expect(page.getByText('VW02_MARKDOWN_READY')).toBeVisible();
      await expect(page.getByTestId('workspace-child-strip')).toBeVisible();

      await page.getByTestId('workspace-display-tab').click();
      await expect(page).toHaveURL(new RegExp(`/dock/shell/agentic_process-${fixture.processId}\\?.*viewMode=vibe`));
      await expect(htmlPreview).toBeVisible();
      await page.reload();
      await expect(htmlFrame.locator('#activate')).toHaveText('VW03_HTML_READY');
    } finally {
      await destroyVibeFixture(request, fixture);
    }
  });

  test('VW-04/VW-05/VW-06: one running app target remains interactive and refreshes in place', async ({
    page,
    request,
  }) => {
    const fixture = await createVibeFixture(request, 'vibe-running-app');
    let marker = 'VW04_EXISTING_APP';
    let countStep = 1;
    const server = createServer((_request, response) => {
      response.setHeader('Content-Type', 'text/html');
      response.end(
        `<!doctype html>
        <p id="marker">${marker}</p>
        <button id="count" onclick="this.textContent=String(Number(this.textContent)+${countStep})">0</button>`,
      );
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('app fixture has no TCP port');
      await showPort(request, fixture.processId, address.port);
      await openVibe(page, fixture.processId);

      const app = page.frameLocator('[data-testid="vibe-webapp-frame"]');
      await expect(app.locator('#marker')).toHaveText('VW04_EXISTING_APP');
      await app.locator('#count').click();
      await expect(app.locator('#count')).toHaveText('1');

      marker = 'VW06_VERSION_TWO';
      countStep = 2;
      await page.reload();
      await expect(app.locator('#marker')).toHaveText('VW06_VERSION_TWO');
      await app.locator('#count').click();
      await expect(app.locator('#count')).toHaveText('2');

      const process = (await (await request.get(`${API}/api/v1/graph/agentic_process/${fixture.processId}`)).json())
        .data;
      expect(process.context_data.display_stack).toHaveLength(1);
      expect(process.context_data.last_shown).toMatchObject({
        kind: 'webapp',
        port: address.port,
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await destroyVibeFixture(request, fixture);
    }
  });

  test('VW-08/VW-09/VW-13: project skill and image targets use their real viewers and survive reload', async ({
    page,
    request,
  }) => {
    const fixture = await createVibeFixture(request, 'vibe-skill-image');
    try {
      const skillResponse = await request.post(`${API}/api/v1/graph/project/${fixture.projectId}/skill`, {
        data: { name: 'vibe-qa-greeter' },
      });
      expect(skillResponse.status()).toBe(200);
      const skill = (await skillResponse.json()).data;
      const skillDir = String(skill.asset_ref).replace(/\/SKILL\.md$/, '');
      mkdirSync(path.join(skillDir, 'references'), { recursive: true });
      writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        '---\nname: vibe-qa-greeter\ndescription: QA greeter\n---\n\nVIBE_GREETER_RAN\n',
        'utf8',
      );
      writeFileSync(path.join(skillDir, 'references', 'checklist.md'), 'VW09_REFERENCE\n', 'utf8');

      await showTypeId(request, fixture.processId, `skill-${skill.id}`);
      await openVibe(page, fixture.processId);
      await expect(page.getByText('VIBE_GREETER_RAN')).toBeVisible();
      await expect(page.getByText(/File is missing/i)).toHaveCount(0);
      await page.reload();
      await expect(page.getByText('VIBE_GREETER_RAN')).toBeVisible();

      const imagePath = path.join(fixture.root, 'vibe-dog.png');
      writeFileSync(
        imagePath,
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4xQAAAAASUVORK5CYII=',
          'base64',
        ),
      );
      await showPath(request, fixture.processId, imagePath);
      await page.reload();
      const image = page.getByTestId('media-viewer-image');
      await expect(image).toBeVisible();
      expect(await image.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBeGreaterThan(0);
      await page.reload();
      await expect(page.getByTestId('media-viewer-image')).toBeVisible();
    } finally {
      await destroyVibeFixture(request, fixture);
    }
  });

  test('VW-17/VW-18/VW-19/VW-20: asset entry stays URL-first, updates live, and shown related assets become children', async ({
    page,
    request,
  }) => {
    const fixture = await createVibeFixture(request, 'vibe-asset-origin');
    const createdIds: string[] = [];
    try {
      const createMarkdown = async (name: string, marker: string) => {
        const response = await request.post(`${API}/api/v1/graph/project/${fixture.projectId}/markdown`, {
          data: { name },
        });
        expect(response.status()).toBe(200);
        const entity = (await response.json()).data as {
          id: string;
          asset_ref: string;
        };
        createdIds.push(entity.id);
        const scaffold = readFileSync(entity.asset_ref, 'utf8');
        writeFileSync(entity.asset_ref, `${scaffold}\n# ${marker}\n`, 'utf8');
        return entity;
      };

      const source = await createMarkdown('vibe-origin-source', 'VW17_ORIGINAL');
      const related = await createMarkdown('vibe-origin-related', 'VW20_RELATED');
      const processResponse = await request.get(`${API}/api/v1/graph/agentic_process/${fixture.processId}`);
      const process = (await processResponse.json()).data;
      const updateProcess = await request.put(`${API}/api/v1/graph/agentic_process/${fixture.processId}`, {
        data: {
          ...process,
          process_type: 'chat',
          target_typeid_str: `markdown-${source.id}`,
        },
      });
      expect(updateProcess.status()).toBe(200);

      await page.addInitScript(() => localStorage.setItem('llm-setup-modal-seen', 'true'));
      await page.goto(`/dock/assets/editor/markdown/typeid/markdown-${source.id}?viewMode=standard`);
      await expect(page.getByText('vibe-origin-source.md')).toBeVisible();
      await expect(page.getByTestId('assets-page-header').getByTestId('asset-discuss-in-vibe')).toBeVisible();
      expect(await page.locator('[data-panel-id="asset-vibe-chat"]').getAttribute('data-panel-size')).toBe('0.0');
      expect(await page.locator('[data-panel-id="asset-vibe-content"]').getAttribute('data-panel-size')).toBe('100.0');
      const before = new URL(page.url());
      await page.getByTestId('asset-discuss-in-vibe').click();

      await expect(page).toHaveURL(/\/dock\/assets\/editor\/markdown\/.*viewMode=vibe/);
      const after = new URL(page.url());
      expect(after.pathname).toBe(before.pathname);
      await expect(page.locator('[data-testid="entity-execution-new"]:visible')).toBeVisible();
      await expect(page.getByText('vibe-origin-source.md')).toBeVisible();
      await expect(page.getByTestId('workspace-child-strip')).toBeVisible();
      expect(await page.locator('[data-panel-id="asset-vibe-chat"]').getAttribute('data-panel-size')).toBe('36.0');
      expect(await page.locator('[data-panel-id="asset-vibe-content"]').getAttribute('data-panel-size')).toBe('64.0');

      writeFileSync(source.asset_ref, `${readFileSync(source.asset_ref, 'utf8')}\n# VW18_LIVE_UPDATE\n`, 'utf8');
      const reindex = await request.post(`${API}/api/v1/graph/compute_node/@local/fs-records/invalidate`, {
        data: { paths: [source.asset_ref], deleted_paths: [] },
      });
      expect(reindex.status()).toBe(200);
      await expect(page.getByText('VW18_LIVE_UPDATE')).toBeVisible();

      await showTypeId(request, fixture.processId, `markdown-${related.id}`);
      await expect(page).toHaveURL(new RegExp(`/dock/assets/editor/markdown/typeid/markdown-${related.id}`));
      await expect(page.getByText('VW20_RELATED')).toBeVisible();
      await expect(page.locator('[data-testid="entity-execution-new"]:visible')).toBeVisible();
      await expect(page.getByTestId('workspace-child-strip')).toBeVisible();
      await page.reload();
      await expect(page.getByText('VW20_RELATED')).toBeVisible();
      await expect(page.locator('[data-testid="entity-execution-new"]:visible')).toBeVisible();
      expect(await page.locator('[data-panel-id="asset-vibe-chat"]').getAttribute('data-panel-size')).toBe('36.0');
      expect(await page.locator('[data-panel-id="asset-vibe-content"]').getAttribute('data-panel-size')).toBe('64.0');
    } finally {
      for (const id of createdIds) {
        await request.delete(`${API}/api/v1/graph/markdown/${id}`).catch(() => undefined);
      }
      await destroyVibeFixture(request, fixture);
    }
  });
});
