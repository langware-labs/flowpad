import { expect, test, type Page } from '@playwright/test';
import { ensureProjectMarkdown } from './_seed';


function realConsoleErrors(errors: string[]): string[] {
  return errors.filter(
    (e) =>
      !e.includes('ResizeObserver') &&
      !e.includes('favicon') &&
      !e.includes('Error fetching entity by type ID: user-') &&
      !e.includes('ERR_CONNECTION_REFUSED') &&
      !/agent_hook\/.*\/watch/.test(e),
  );
}

// Opens the markdown asset list, expands the markdown type + any doc folders,
// and clicks the first markdown row to open it in the editor.
async function openFirstMarkdownDoc(page: Page) {
  // Project-scoped tree on a fresh instance has an empty docs folder — seed
  // one doc so "the first .md leaf" exists (see _seed.ts).
  await ensureProjectMarkdown(page.request);
  await page.goto('/dock/assets/list/markdown');
  await page.locator('[data-testid="flow-page"]').waitFor({ state: 'visible', timeout: 30_000 });
  // Markdown leaf rows are role="treeitem" with a "<name>.md" label.
  const leaf = page.locator('[role="treeitem"]').filter({ hasText: /\.md$/ }).first();
  await page.locator('[data-testid^="browseable-chevron-asset-type:markdown:"]').first().click().catch(() => {});
  // Expand the markdown type and any nested doc folders until a .md leaf shows.
  for (let attempt = 0; attempt < 20; attempt++) {
    if (await leaf.isVisible().catch(() => false)) break;
    const folders = page.locator('[data-testid^="browseable-chevron-md-folder:"]');
    const fcount = await folders.count();
    for (let i = 0; i < fcount; i++) await folders.nth(i).click().catch(() => {});
    await page.waitForTimeout(300);
  }
  await expect(leaf).toBeVisible({ timeout: 15_000 });
  await leaf.click();
  await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 20_000 });
}

test.describe('Markdown editor header has no "Wiki" back button', () => {
  test('header shows mode toggle + no Wiki button and no left-edge back arrow', async ({ page }) => {
    test.setTimeout(60_000);
    await page.addInitScript(() => localStorage.setItem('llm-setup-modal-seen', 'true'));

    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await openFirstMarkdownDoc(page);

    // Mode toggle group is present in the editor header.
    for (const mode of ['view', 'review', 'editor', 'markdown']) {
      await expect(page.locator(`[data-testid="editor-mode-chip-${mode}"]`)).toBeVisible({ timeout: 10_000 });
    }

    // The copy-path / reveal control (ExternalLink icon) is present.
    await expect(page.locator('[data-testid="markdown-editor-open-external"]')).toBeVisible({ timeout: 10_000 });

    // There must be NO button whose text is "Wiki".
    const wikiButtons = page.getByRole('button', { name: /^Wiki$/ });
    expect(await wikiButtons.count(), 'A "Wiki" button is present in the editor header').toBe(0);
    // And no element labelled Wiki anywhere in the header region.
    expect(
      await page.getByText(/^Wiki$/).count(),
      'A "Wiki" label is present in the editor header',
    ).toBe(0);

    const real = realConsoleErrors(errors);
    expect(real, `Console errors: ${real.join('\n')}`).toHaveLength(0);
  });
});
