import { expect, test, type Page } from '@playwright/test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apiBase } from '../_shared/api';

const API = apiBase();
const exists = (p: string) =>
  fs.access(p).then(
    () => true,
    () => false,
  );

/** A tree row by the end of its node id (Files rows are `fs-…:<abs path sans slash>`).
 *  Visible only: opening a file opens a new tab, and each tab has its own tree. */
const row = (page: Page, suffix: string) =>
  page.locator(`[data-browseable-id^="fs-"][data-browseable-id$="${suffix}"] > [role="treeitem"]:visible`).first();

async function expand(page: Page, suffix: string) {
  const r = row(page, suffix);
  if ((await r.getAttribute('aria-expanded')) !== 'true') {
    await r.locator('[data-testid^="browseable-chevron-"]').click();
    await expect(r).toHaveAttribute('aria-expanded', 'true');
  }
}

async function menu(page: Page, suffix: string, item: string) {
  await row(page, suffix).click({ button: 'right' });
  await page.locator(`[data-testid^="browseable-menu-${item}:"]`).click();
}

// flowpad:capsule tag
// version: 1
// data:
//   tags:
//     breadcrumb.test.menu_close_focus.rules: FAILING at F2? a closing row menu must
//       not pull focus back - read this tag's rules
// flowpad:endcapsule tag
test('the Files tree is a file manager', async ({ page, request }) => {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('llm-setup-modal-seen', 'true');
    } catch {
      /* no storage in a sandboxed frame */
    }
  });
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'flowpad-docs-crud-')));
  for (const f of ['docs/a.md', 'docs/b.md', 'notes/n.md']) {
    await fs.mkdir(path.dirname(path.join(root, f)), { recursive: true });
    await fs.writeFile(path.join(root, f), `# ${f}\n`);
  }
  const created = await request.post(`${API}/api/v1/graph/project`, {
    data: { name: path.basename(root), fs_storage_mount_path: root },
  });
  expect(created.status()).toBe(200);
  const projectId = (await created.json()).data.id as string;
  const rel = root.replace(/^\/+/, '');

  try {
    await page.goto(`/dock/assets?scope-mode=project&scope-activeProjectId=${projectId}`);
    await expand(page, `:${rel}`);
    await expand(page, `${rel}/docs`);
    await expand(page, `${rel}/notes`);

    // Right-click menus
    await row(page, 'docs/a.md').click({ button: 'right' });
    for (const item of ['open', 'cut', 'copy', 'duplicate', 'rename', 'delete', 'copy-path', 'copy-rel-path', 'reveal', 'download']) {
      await expect(page.locator(`[data-testid^="browseable-menu-${item}:"]`)).toBeVisible();
    }
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await row(page, `${rel}/docs`).click({ button: 'right' });
    for (const item of ['new-file', 'new-folder', 'paste', 'terminal', 'upload', 'download']) {
      await expect(page.locator(`[data-testid^="browseable-menu-${item}:"]`)).toBeVisible();
    }
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);

    // Toolbar: new folder
    await row(page, `${rel}/docs`).hover();
    await row(page, `${rel}/docs`).getByRole('button', { name: 'New folder' }).click();
    await page.getByRole('dialog').getByRole('textbox').fill('archive');
    await page.keyboard.press('Enter');
    await expect.poll(() => exists(path.join(root, 'docs/archive'))).toBe(true);
    await expect(row(page, 'docs/archive')).toBeVisible();

    // Copy / paste
    await menu(page, 'docs/a.md', 'copy');
    await menu(page, `${rel}/notes`, 'paste');
    await expect.poll(() => exists(path.join(root, 'notes/a.md'))).toBe(true);
    expect(await exists(path.join(root, 'docs/a.md'))).toBe(true);

    // F2 rename
    // Focus without opening: opening a file starts a new tab whose tree
    // reveals it under Documents, so the Files row would not be on screen.
    await row(page, 'notes/a.md').focus();
    await page.keyboard.press('F2');
    await page.locator('[data-testid^="browseable-rename-"]:visible').fill('renamed.md');
    await page.keyboard.press('Enter');
    await expect.poll(() => exists(path.join(root, 'notes/renamed.md'))).toBe(true);
    await expect(row(page, 'notes/renamed.md')).toBeVisible();

    // ⌘D duplicate
    await row(page, 'docs/b.md').focus();
    await page.keyboard.press('ControlOrMeta+d');
    await expect.poll(() => exists(path.join(root, 'docs/b copy.md'))).toBe(true);

    // Drag move
    await row(page, 'docs/b.md').dragTo(row(page, `${rel}/notes`));
    await expect.poll(() => exists(path.join(root, 'notes/b.md'))).toBe(true);
    expect(await exists(path.join(root, 'docs/b.md'))).toBe(false);

    // OS file dropped in
    const dt = await page.evaluateHandle(() => {
      const d = new DataTransfer();
      d.items.add(new File(['# dropped\n'], 'dropped.md', { type: 'text/markdown' }));
      return d;
    });
    await row(page, `${rel}/docs`).dispatchEvent('dragover', { dataTransfer: dt });
    await row(page, `${rel}/docs`).dispatchEvent('drop', { dataTransfer: dt });
    await expect.poll(() => exists(path.join(root, 'docs/dropped.md'))).toBe(true);

    // Multi-select delete
    await row(page, 'docs/a.md').locator('span.truncate').click({ modifiers: ['ControlOrMeta'] });
    await row(page, 'docs/dropped.md').locator('span.truncate').click({ modifiers: ['ControlOrMeta'] });
    await row(page, 'docs/dropped.md').focus();
    await page.keyboard.press('Delete');
    await expect(page.getByText('Delete 2 items?')).toBeVisible();
    await page.getByRole('button', { name: 'Confirm' }).click();
    await expect.poll(() => exists(path.join(root, 'docs/a.md'))).toBe(false);
    expect(await exists(path.join(root, 'docs/dropped.md'))).toBe(false);
    await expect(page.locator('[data-multi-selected]')).toHaveCount(0);
  } finally {
    await request.delete(`${API}/api/v1/graph/project/${projectId}`).catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});
