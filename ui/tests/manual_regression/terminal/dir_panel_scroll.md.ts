/**
 * Regression test: Dir side window must SCROLL when its contents overflow.
 *
 * Bug (proven in-browser, this session):
 *   The agentic-process Dir side window (?sideWindows=dir) renders SimpleDirTree,
 *   whose root is `flex-1` and whose file list lives in an inner `overflow-y-auto`.
 *   TabbedSideDrawer mounts that panel in a plain BLOCK wrapper
 *   (`min-h-0 flex-1 overflow-hidden`, side-drawer.tsx:260). `flex-1` is inert
 *   inside a block parent, so the panel grows to its full content height, the
 *   surplus is clipped by `overflow-hidden`, and the inner scroll box never
 *   registers overflow → no scrollbar, bottom entries are unreachable.
 *
 *   On/off switch (proven live): wrapper display:block → not scrollable / clipped;
 *   display:flex (flex-col) → scrollable / not clipped; revert → broken again.
 *   Fix: make that wrapper a flex column (`flex … flex-col`).
 *
 * This test drives the REAL app in a REAL browser (Chromium) so layout is
 * actually computed — jsdom (the vitest/RTL tier) has no layout engine and
 * reports clientHeight/scrollHeight as 0, so it cannot observe this at all.
 *
 * Assumes the backend + frontend are already running (see playwright.config.ts).
 */
import { test, expect, type Page } from '@playwright/test';
import { dismissSetupModal, activePanel, ensureAdvancedView, skipIfPtyExhausted, startClaudeSession } from './helpers';

let cachedAgenticUrl: string | null = null;

/** Land on an agentic-process terminal (create one via "Start Claude" if needed). */
async function gotoAgenticProcess(page: Page): Promise<string> {
  // Allow pointing the test at an already-running agentic process (avoids
  // creating a fresh Claude session). The path is the /dock/shell/... portion.
  const fixed = process.env.DIR_TEST_PROCESS_PATH;
  if (fixed) {
    await page.goto(fixed);
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
    return fixed.split('?')[0];
  }

  if (cachedAgenticUrl) {
    await page.goto(cachedAgenticUrl);
    const ok = await activePanel(page)
      .locator('.border-t .ml-auto')
      .isVisible({ timeout: 10_000 })
      .catch(() => false);
    if (ok) return cachedAgenticUrl;
  }

  await page.goto('/dock/shell/new_terminal');
  const skip = page.getByRole('button', { name: 'Skip' });
  if (await skip.isVisible({ timeout: 2_000 }).catch(() => false)) await skip.click();
  try {
    await page.waitForURL(/\/dock\/shell\/(shell-|agentic_process-)/, { timeout: 60_000 });

    if (!page.url().includes('agentic_process-')) {
      await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 60_000 });
      await startClaudeSession(page);
      await page.waitForURL(/\/dock\/shell\/agentic_process-(?!new)/, { timeout: 60_000 });
    }

    // The Dir side window is a ribbon panel — Advanced-view only; the backend
    // pref now wins over the localStorage seed, so flip to Advanced at runtime.
    await ensureAdvancedView(page);
    await expect(activePanel(page).locator('.border-t .ml-auto')).toBeVisible({ timeout: 60_000 });
  } catch (e) {
    await skipIfPtyExhausted(page);
    throw e;
  }
  await page.waitForTimeout(3_000);
  cachedAgenticUrl = page.url().split('?')[0];
  return cachedAgenticUrl;
}

test.describe('Dir side window scrolling', () => {
  test.beforeEach(async ({ page }) => {
    await dismissSetupModal(page);
  });

  test('dir panel scrolls (not clipped) when the directory overflows the viewport', async ({ page }) => {
    test.setTimeout(90_000);

    const base = await gotoAgenticProcess(page);

    // Open the Dir side window exactly as the bug repro does: via the URL param.
    await page.goto(`${base}?sideWindows=dir`);

    // Wait for the dir tree to mount and load its rows.
    const filter = activePanel(page).locator('[data-testid="dir-tree-filter"]');
    await expect(filter).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(2_000); // let the directory listing populate

    // Measure the REAL layout of the scroll chain inside the active panel.
    const metrics = await activePanel(page).evaluate((panel) => {
      const f = panel.querySelector('[data-testid="dir-tree-filter"]');
      if (!f) return null;
      const dirRoot = f.parentElement!.parentElement!; // SimpleDirTree root
      const scroll = [...dirRoot.children].find(
        (c) => getComputedStyle(c as Element).overflowY === 'auto',
      ) as HTMLElement | undefined;
      const wrapper = dirRoot.parentElement as HTMLElement; // TabbedSideDrawer content wrapper
      if (!scroll || !wrapper) return null;
      // Try to actually scroll the inner box to the bottom.
      scroll.scrollTop = 1e6;
      const movedScrollTop = scroll.scrollTop;
      return {
        wrapperClientH: wrapper.clientHeight,
        dirRootScrollH: dirRoot.scrollHeight, // full natural height of the panel content
        scrollClientH: scroll.clientHeight,
        scrollScrollH: scroll.scrollHeight,
        movedScrollTop,
        // Clipped iff the panel's content is taller than the wrapper that's
        // supposed to bound it (block wrapper ⇒ panel overflows & is cut off).
        clipped: dirRoot.scrollHeight > wrapper.clientHeight + 1,
      };
    });

    expect(metrics, 'dir tree scroll chain not found in active panel').not.toBeNull();
    const m = metrics!;

    // Precondition: the directory must actually overflow the viewport, otherwise
    // there is nothing to scroll and the bug cannot manifest. Gate on the inner
    // list's natural content height (scrollScrollH) vs the bounded wrapper —
    // dirRootScrollH can't be used here because the FIX bounds it to the wrapper,
    // which would mask "has overflow" once fixed.
    if (m.scrollScrollH <= m.wrapperClientH + 1) {
      test.skip(true, `Directory fits without overflow (list ${m.scrollScrollH}px ≤ wrapper ${m.wrapperClientH}px) — not enough entries to exercise scrolling`);
      return;
    }

    // 1. The panel must NOT be clipped: its content height must be bounded by the
    //    wrapper (the broken block wrapper lets it grow past and clips it).
    expect(
      m.clipped,
      `Dir panel content (${m.dirRootScrollH}px) overflows its wrapper (${m.wrapperClientH}px) and is clipped — block wrapper, no scroll`,
    ).toBe(false);

    // 2. The inner scroll box must register overflow and actually scroll.
    expect(
      m.scrollScrollH,
      `inner scroll box should overflow (scrollHeight ${m.scrollScrollH} > clientHeight ${m.scrollClientH})`,
    ).toBeGreaterThan(m.scrollClientH);
    expect(m.movedScrollTop, 'scrolling the dir list did not move scrollTop').toBeGreaterThan(0);
  });
});
