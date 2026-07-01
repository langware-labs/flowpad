import { expect, test, type Page } from '@playwright/test';
import { ensureProjectMarkdown } from './_seed';


// ── Helpers ───────────────────────────────────────────────────────────────

// Open the markdown asset list, expand the markdown type + any doc folders,
// and click the first markdown row to open it in the editor.
async function openFirstMarkdownDoc(page: Page) {
  // Project-scoped tree on a fresh instance has an empty docs folder — seed
  // one doc so "the first .md leaf" exists (see _seed.ts).
  await ensureProjectMarkdown(page.request);
  await page.goto('/dock/assets/list/markdown');
  await page.locator('[data-testid="flow-page"]').waitFor({ state: 'visible', timeout: 30_000 });
  const leaf = page.locator('[role="treeitem"]').filter({ hasText: /\.md$/ }).first();
  await page.locator('[data-testid^="browseable-chevron-asset-type:markdown:"]').first().click().catch(() => {});

  // Expand the markdown type and any nested doc folders until a .md leaf is
  // visible. Poll instead of fixed sleeps so this stays fast and does not
  // depend on a single hard-coded settle duration.
  for (let attempt = 0; attempt < 20; attempt++) {
    if (await leaf.isVisible().catch(() => false)) break;
    const folders = page.locator('[data-testid^="browseable-chevron-md-folder:"]');
    const fcount = await folders.count();
    for (let i = 0; i < fcount; i++) await folders.nth(i).click().catch(() => {});
    await page.waitForTimeout(300);
  }
  await expect(leaf).toBeVisible({ timeout: 15_000 });
  await leaf.click();
  // "Doc opened" = the MarkdownEditor header mounted. Do NOT wait on `.ProseMirror`
  // here: the chosen editor mode is persisted across docs (PrefKey.EDITOR_MODE), so a
  // doc can restore in Review mode (ReviewSurface, no `.ProseMirror`) — the view chip
  // is rendered in every mode, making it a mode-agnostic open signal. Each test then
  // drives setMode() to the mode it needs.
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

async function setMode(page: Page, mode: 'view' | 'review' | 'editor' | 'markdown') {
  const chip = page.locator(`[data-testid="editor-mode-chip-${mode}"]`);
  // The mode-chip click drives MarkdownEditor.setViewMode, which early-returns if
  // the dock context isn't mounted yet — so a click fired before the editor
  // surface exists is a silent no-op. Wait for the editor body (read-only
  // .ProseMirror or the review surface) and for the mode-chip strip to be
  // interactive, then click once and confirm the chip flipped active.
  await page.locator('.ProseMirror, [data-testid="review-surface"]').first().waitFor({ state: 'visible', timeout: 15_000 });
  await expect(chip).toBeEnabled({ timeout: 10_000 });
  await chip.click();
  await expect(chip).toHaveAttribute('data-mode-active', 'true', { timeout: 10_000 });
  await page.waitForTimeout(300);
}

// Programmatically select the first `n` characters of the first text block in
// the given content container via a native DOM range — ProseMirror's
// DOMObserver syncs this into its selection, driving the selectionUpdated
// listener. Defaults to the editable .ProseMirror used in editor/view modes.
async function selectFirstChars(page: Page, n: number, container = '.ProseMirror'): Promise<string> {
  // For EDITABLE views, focus must SETTLE before the synthetic selectionchange
  // fires: ProseMirror's DOMObserver.onSelectionChange early-returns when
  // !view.hasFocus() on an editable view, silently dropping the selection sync
  // (RCA: Phase-8 Debug #4). A real click puts focus in the editor the way a
  // user would (mousedown → focus → selection); then wait for activeElement to
  // land inside. Non-editable (view/review) containers can't take focus — the
  // hasFocus gate doesn't apply there, so select directly as before.
  const isEditable = await page
    .locator(container)
    .first()
    .evaluate((el) => (el as HTMLElement).isContentEditable);
  if (isEditable) {
    await page.locator(container).first().click({ position: { x: 10, y: 10 } });
    await page.waitForFunction(
      (containerSel) => {
        const root = document.querySelector(containerSel);
        return !!root && root.contains(document.activeElement);
      },
      container,
    );
  }
  return page.evaluate(
    ({ count, sel: containerSel }) => {
      const root = document.querySelector(containerSel) as HTMLElement | null;
      if (!root) return '';
      const block = (root.querySelector('p, h1, h2, h3, li') as HTMLElement) || root;
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      const node = walker.nextNode();
      if (!node) return '';
      const len = Math.min(count, (node.textContent || '').length);
      const sel = window.getSelection()!;
      const range = document.createRange();
      range.setStart(node, 0);
      range.setEnd(node, len);
      sel.removeAllRanges();
      sel.addRange(range);
      return sel.toString();
    },
    { count: n, sel: container },
  );
}

// ── Test 1 ──────────────────────────────────────────────────────────────────
test.describe('Milkdown selection toolbar', () => {
  test('selection toolbar appears above a non-empty selection in editor mode', async ({ page }) => {
    test.setTimeout(60_000);
    await page.addInitScript(() => { localStorage.setItem('llm-setup-modal-seen', 'true'); localStorage.setItem('viewMode', 'advanced'); });
    await openFirstMarkdownDoc(page);
    await setMode(page, 'editor');
    await expect(page.locator('.ProseMirror[contenteditable="true"]')).toBeVisible({ timeout: 10_000 });

    const selected = await selectFirstChars(page, 6);
    expect(selected.length, 'No text was selected').toBeGreaterThan(0);
    await page.waitForTimeout(150); // selectionUpdated listener flush (setTimeout 0 + render)

    const toolbar = page.locator('[data-testid="selection-toolbar"]');
    await expect(toolbar).toBeVisible({ timeout: 5_000 });

    // Exactly 4 buttons with these titles.
    const titles = await toolbar.locator('button').evaluateAll((els) => els.map((b) => b.getAttribute('title')));
    expect(titles.length).toBe(4);
    expect(titles[0]).toBe('Bold');
    expect(titles[1]).toBe('Italic');
    expect(titles[2]).toBe('Inline code');
    expect(['Add link', 'Edit link']).toContain(titles[3]);

    // Toolbar floats above the selection (smaller y than the selection rect).
    const tbBox = await toolbar.boundingBox();
    const selTop = await page.evaluate(() => {
      const r = window.getSelection()!.getRangeAt(0).getBoundingClientRect();
      return r.top;
    });
    expect(tbBox).not.toBeNull();
    expect(tbBox!.y, 'Selection toolbar is not floating above the selection').toBeLessThan(selTop);
  });

  // ── Test 2 ──────────────────────────────────────────────────────────────────
  test('Bold button formats the selected text', async ({ page }) => {
    test.setTimeout(60_000);
    await page.addInitScript(() => { localStorage.setItem('llm-setup-modal-seen', 'true'); localStorage.setItem('viewMode', 'advanced'); });
    await openFirstMarkdownDoc(page);
    await setMode(page, 'editor');

    const selected = await selectFirstChars(page, 6);
    await page.waitForTimeout(150);
    const toolbar = page.locator('[data-testid="selection-toolbar"]');
    await expect(toolbar).toBeVisible({ timeout: 5_000 });

    // mousedown drives the format command (the button's onMouseDown handler).
    await toolbar.locator('button[title="Bold"]').dispatchEvent('mousedown');
    await page.waitForTimeout(200);

    // The selected substring is now wrapped in <strong>. A markdown strong mark
    // cannot include leading/trailing whitespace (`**Agent **` is not valid emphasis),
    // so when the 6-char selection ends in a space ("Agent ") ProseMirror applies the
    // mark to the trimmed run and pushes the space outside — the resulting
    // <strong> textContent is the selection with boundary whitespace removed.
    const expectedBold = selected.trim();
    const strongHasText = await page.evaluate((sub) => {
      const strongs = Array.from(document.querySelectorAll('.ProseMirror strong'));
      return strongs.some((s) => (s.textContent || '') === sub);
    }, expectedBold);
    expect(strongHasText, `No <strong> wrapping the selected text "${expectedBold}"`).toBe(true);

    // The toolbar is still visible (selection has not collapsed).
    await expect(toolbar).toBeVisible();
  });

  // ── Test 3 ──────────────────────────────────────────────────────────────────
  test('selection toolbar disappears when the selection collapses', async ({ page }) => {
    test.setTimeout(60_000);
    await page.addInitScript(() => { localStorage.setItem('llm-setup-modal-seen', 'true'); localStorage.setItem('viewMode', 'advanced'); });
    await openFirstMarkdownDoc(page);
    await setMode(page, 'editor');

    await selectFirstChars(page, 6);
    await page.waitForTimeout(150);
    const toolbar = page.locator('[data-testid="selection-toolbar"]');
    await expect(toolbar).toBeVisible({ timeout: 5_000 });

    // Collapse the selection.
    await page.evaluate(() => window.getSelection()!.collapseToEnd());
    await page.waitForTimeout(200);

    await expect(toolbar).toHaveCount(0);
  });

  // ── Test 4 ──────────────────────────────────────────────────────────────────
  test('selection toolbar is hidden in view and review modes', async ({ page }) => {
    test.setTimeout(60_000);
    await page.addInitScript(() => { localStorage.setItem('llm-setup-modal-seen', 'true'); localStorage.setItem('viewMode', 'advanced'); });
    await openFirstMarkdownDoc(page);

    const toolbar = page.locator('[data-testid="selection-toolbar"]');

    // View mode (default after open) — read-only .ProseMirror; selecting text
    // must not surface the editor-only selection toolbar.
    await setMode(page, 'view');
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 10_000 });
    await selectFirstChars(page, 6, '.ProseMirror');
    await page.waitForTimeout(250);
    await expect(toolbar).toHaveCount(0);

    // Review mode renders the ReviewSurface (no editor) — same expectation.
    await setMode(page, 'review');
    await expect(page.locator('[data-testid="review-surface"]')).toBeVisible({ timeout: 10_000 });
    await selectFirstChars(page, 6, '[data-testid="review-surface"]');
    await page.waitForTimeout(250);
    await expect(toolbar).toHaveCount(0);
  });

  // ── Test 5 ──────────────────────────────────────────────────────────────────
  test('selection toolbar is suppressed while the LinkPopup is open', async ({ page }) => {
    test.setTimeout(60_000);
    await page.addInitScript(() => { localStorage.setItem('llm-setup-modal-seen', 'true'); localStorage.setItem('viewMode', 'advanced'); });
    await openFirstMarkdownDoc(page);
    await setMode(page, 'editor');

    await selectFirstChars(page, 6);
    await page.waitForTimeout(150);
    const toolbar = page.locator('[data-testid="selection-toolbar"]');
    await expect(toolbar).toBeVisible({ timeout: 5_000 });

    // Open the link popup from the selection toolbar.
    await toolbar.locator('[data-testid="milkdown-toolbar-link"]').dispatchEvent('mousedown');
    const linkPopup = page.locator('[data-testid="milkdown-link-popup"][data-mode="new"]');
    await expect(linkPopup).toBeVisible({ timeout: 5_000 });

    // While the popup is open, the selection toolbar is not present.
    await expect(toolbar).toHaveCount(0);

    // Closing the popup with Escape restores the selection toolbar.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    await expect(toolbar).toBeVisible({ timeout: 5_000 });
  });

  // ── Test 6 ──────────────────────────────────────────────────────────────────
  test('selection toolbar reuses the same FormatButton as the static toolbar', async ({ page }) => {
    test.setTimeout(60_000);
    await page.addInitScript(() => { localStorage.setItem('llm-setup-modal-seen', 'true'); localStorage.setItem('viewMode', 'advanced'); });
    await openFirstMarkdownDoc(page);
    await setMode(page, 'editor');

    await selectFirstChars(page, 6);
    await page.waitForTimeout(150);
    const toolbar = page.locator('[data-testid="selection-toolbar"]');
    await expect(toolbar).toBeVisible({ timeout: 5_000 });

    const popupBoldClass = await toolbar.locator('button[title="Bold"]').getAttribute('class');
    // The static toolbar lives in the editor chrome (border-b bg-muted/20 cluster);
    // grab the Bold button that is NOT inside the selection toolbar.
    const staticBoldClass = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('button[title="Bold"]'));
      const stat = all.find((b) => !b.closest('[data-testid="selection-toolbar"]'));
      return stat ? stat.getAttribute('class') : null;
    });
    expect(staticBoldClass, 'No static-toolbar Bold button found').not.toBeNull();
    // Both must carry the shared FormatButton sizing classes.
    expect(popupBoldClass).toContain('h-7');
    expect(popupBoldClass).toContain('w-7');
    expect(staticBoldClass).toContain('h-7');
    expect(staticBoldClass).toContain('w-7');
    expect(popupBoldClass).toBe(staticBoldClass);
  });
});
