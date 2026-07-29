import { expect, test } from '@playwright/test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apiBase } from '../_shared/api';

const API = apiBase();

test('a VFS editor URL selects the real file in the Files tree', async ({ page, request }) => {
  await page.addInitScript(() => localStorage.setItem('llm-setup-modal-seen', 'true'));
  // macOS exposes the temp tree through both /var and /private/var. The project
  // route adopts the canonical mount, so build the VFS URL from that same
  // identity instead of manufacturing two names for one file.
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'flowpad-vfs-selection-')));
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
    await expect(pageHeader.locator('[data-entity-type-icon]')).toBeVisible();
    // A raw external VFS file is not an indexed entity, so entity-only actions
    // (Share / favorite) are intentionally absent. Discuss remains available.
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
