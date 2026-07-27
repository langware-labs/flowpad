import { expect, test } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { apiBase } from '../_shared/api';

const API = apiBase();

test('a VFS editor URL selects the real file in the Files tree', async ({ page, request }) => {
  await page.addInitScript(() => localStorage.setItem('llm-setup-modal-seen', 'true'));
  const root = await fs.mkdtemp(path.resolve(process.cwd(), '..', '.flowpad-vfs-selection-'));
  const file = path.join(root, 'docs', 'agent', 'interface.md');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '# Interface\n');

  const created = await request.post(`${API}/api/v1/graph/project`, {
    data: { name: path.basename(root), fs_storage_mount_path: root },
  });
  expect(created.status()).toBe(200);
  const projectId = (await created.json()).data.id as string;

  try {
    const vfs = `compute_node-@local/${file.replace(/^\/+/, '')}`;
    await page.goto(
      `/dock/assets/editor/markdown/vfs/${vfs}?editorMode=view&viewMode=standard&scope-mode=project&scope-activeProjectId=${projectId}`,
    );

    await expect(page.getByRole('button', { name: 'view', exact: true })).toBeVisible();
    const pageHeader = page.getByTestId('assets-page-header');
    await expect(pageHeader).toContainText('interface.md');
    await expect(pageHeader.getByTestId('assets-page-header-path')).toContainText('/docs/agent');
    await expect(pageHeader.getByTestId('assets-page-header-copy-path')).toBeVisible();
    const headerEntityIcon = pageHeader.locator('[data-entity-location="local"]');
    await expect(headerEntityIcon).toBeVisible();
    await expect(headerEntityIcon.locator('[data-location-glyph="local"]')).toBeVisible();
    await expect(headerEntityIcon.locator('[data-entity-type-icon]')).toBeVisible();
    await expect(headerEntityIcon).toHaveAttribute('aria-label', /Local only/);
    await expect(
      headerEntityIcon.locator('[data-location-glyph], [data-entity-type-icon]'),
    ).toHaveCount(2);
    expect(
      await headerEntityIcon
        .locator('[data-location-glyph], [data-entity-type-icon]')
        .evaluateAll((nodes) =>
          nodes.map((node) =>
            node.hasAttribute('data-location-glyph') ? 'location' : 'type',
          ),
        ),
    ).toEqual(['location', 'type']);
    await headerEntityIcon.locator('[data-location-glyph="local"]').hover();
    await expect(page.getByRole('tooltip')).toHaveText('Local only');
    await expect(pageHeader.getByTestId('entity-actions-share')).toBeVisible();
    await expect(pageHeader.getByRole('button', { name: 'Add to favorites' })).toBeVisible();
    await expect(pageHeader.getByTestId('asset-discuss-in-vibe')).toBeVisible();

    const editorHeader = page.getByTestId('asset-editor-header');
    await expect(editorHeader.getByText('interface.md', { exact: true })).toHaveCount(0);
    await expect(editorHeader.locator('[data-entity-location]')).toHaveCount(0);
    await expect(editorHeader.getByTestId('markdown-editor-copy-content')).toBeVisible();
    await expect(editorHeader.getByTestId('asset-discuss-in-vibe')).toHaveCount(0);
    await editorHeader.getByTestId('editor-mode-chip-editor').click();
    const embeddedToolbar = editorHeader.getByTestId('milkdown-toolbar');
    await expect(embeddedToolbar).toBeVisible();
    await expect(embeddedToolbar).toHaveAttribute('data-embedded', 'true');
    await expect(editorHeader.getByTestId('milkdown-toolbar-table')).toBeVisible();
    await expect(page.locator('[data-testid="milkdown-toolbar"][data-embedded="false"]')).toHaveCount(0);
    const assetsTree = page.getByTestId('navigator-panel-assets').getByRole('tree');
    const filesRoot = assetsTree.locator('[data-browseable-id^="fs-root:"]');
    await expect(filesRoot.getByRole('treeitem', { name: /interface\.md/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  } finally {
    await request.delete(`${API}/api/v1/graph/project/${projectId}`).catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});
