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

// Create a markdown asset and open its canonical URL directly. This scenario
// exercises the editor header, not asset-tree expansion or row labels.
async function openFirstMarkdownDoc(page: Page) {
  const markdownId = await ensureProjectMarkdown(page.request);
  await page.goto(`/dock/assets/editor/markdown/typeid/markdown-${markdownId}`);
  // "Doc opened" = the MarkdownEditor header mounted. Do NOT wait on `.ProseMirror`
  // here: the chosen editor mode is persisted across docs (PrefKey.EDITOR_MODE), so a
  // doc can restore in Review mode (ReviewSurface, no `.ProseMirror`) — the view chip
  // is rendered in every mode, making it a mode-agnostic open signal.
  await expect(page.locator('[data-testid="editor-mode-chip-view"]')).toBeVisible({ timeout: 20_000 });
  // The review/markdown mode chips are Advanced-only surfaces. View mode is now a
  // prefMan-owned pref (`preferences.ui.view_mode`) whose backend value wins over the
  // legacy localStorage `viewMode` seed, so setting localStorage alone no longer
  // enters Advanced. Flip it through the live app API the way the footer view pill
  // does (window.setView, exposed by view-mode-context), then wait for the
  // Advanced-only review chip to render.
  await page.evaluate(() => window.setView('advanced'));
  await expect(page.locator('[data-testid="editor-mode-chip-review"]')).toBeVisible({ timeout: 10_000 });
}

test.describe('Markdown editor header has no "Wiki" back button', () => {
  test('header shows mode toggle + no Wiki button and no left-edge back arrow', async ({ page }) => {
    test.setTimeout(60_000);
    await page.addInitScript(() => { localStorage.setItem('llm-setup-modal-seen', 'true'); localStorage.setItem('viewMode', 'advanced'); });

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
