import { test, expect } from '@playwright/test';
import { dismissSetupModal, ensureAdvancedView, skipIfPtyExhausted, startClaudeSession } from './helpers';
import { apiOrigin } from '../_shared/api';

/**
 * Navigate to an agentic process terminal with worker_session_id set.
 * Creates one via "Start Claude" if needed. Returns the process URL.
 */
async function gotoAgenticProcessWithSession(page: import('@playwright/test').Page): Promise<string> {
  await page.goto('/dock/shell/new_terminal');
  const skip = page.getByRole('button', { name: 'Skip' });
  if (await skip.isVisible({ timeout: 2_000 }).catch(() => false)) await skip.click();

  try {
    await page.waitForURL(/\/dock\/shell\/(shell-|agentic_process-)/, { timeout: 60_000 });

    if (!page.url().includes('agentic_process-')) {
      await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
      await startClaudeSession(page);
      await page.waitForURL(/\/dock\/shell\/agentic_process-(?!new)/, { timeout: 60_000 });
    }

    // The annotation gutter + ribbon are Advanced-view surfaces; the backend pref
    // now wins over the localStorage seed, so flip to Advanced at runtime.
    await ensureAdvancedView(page);

    // Wait for the process ribbon (indicates worker_session_id is set)
    const activePanel = page.locator('[data-testid="terminal-panel"][data-active="true"]');
    const ribbon = activePanel.locator('.border-t .ml-auto');
    await expect(ribbon).toBeVisible({ timeout: 60_000 });
  } catch (e) {
    await skipIfPtyExhausted(page);
    throw e;
  }

  return page.url();
}

test.describe('terminal_annotation_bookmark', () => {
  test.beforeEach(async ({ page }) => {
    await dismissSetupModal(page);
  });

  test('test 2: Annotation gutter is not visible in a plain shell terminal', async ({ page }) => {
    test.setTimeout(60_000);

    await page.goto('/dock/shell/new_terminal');
    await page.waitForURL(/\/dock\/shell\/(shell-)/, { timeout: 60_000 });

    // Wait for terminal to be ready (aria-label has lowercase 'i' in 'input')
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
    await expect(page.locator('textarea[aria-label="Terminal input"]').first()).toBeVisible({ timeout: 10_000 });

    // Annotation gutter must NOT be present in a plain shell
    const gutter = page.locator('[data-testid="annotation-gutter"]').first();
    await expect(gutter).not.toBeAttached({ timeout: 3_000 });
  });

  test('test 3: Annotation gutter is visible for existing agentic process with worker session ID', async ({ page }) => {
    test.setTimeout(60_000);

    await gotoAgenticProcessWithSession(page);

    // Annotation gutter must be present for an agentic process with worker_session_id
    const gutter = page.locator('[data-testid="annotation-gutter"]').first();
    await expect(gutter).toBeAttached({ timeout: 10_000 });
  });

  // test 4 (create bookmark) + test 5 (persists with session linkage; listed by
  // a live surface). The original test 5's home BookmarkColumn / "Open Session"
  // `?t=` resume surface was removed in 29e6c667 (2026-06-18); scenario updated
  // 2026-07-07 to guard the surviving contract instead.
  test('test 4+5: Create bookmark; it persists with session linkage and is listed', async ({ page }) => {
    test.setTimeout(60_000);

    // Navigate to an agentic process and capture its ID
    const processUrl = await gotoAgenticProcessWithSession(page);
    const processIdMatch = processUrl.match(/agentic_process-[a-f0-9-]+/);
    expect(
      processIdMatch,
      `agentic-process navigation must resolve an entity URL, got ${processUrl}`,
    ).not.toBeNull();
    const processId = processIdMatch![0];

    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });

    // Wait for annotation gutter
    const gutter = page.locator('[data-testid="annotation-gutter"]').first();
    await expect(gutter).toBeAttached({ timeout: 10_000 });

    // ── Step 2: Click a "+" button in the annotation gutter ───────────────────
    // Target a mid-gutter cell, not .last(): the bottom cell sits below the
    // viewport (clipped) and the empty cells are opacity-0 + occluded, so only a
    // force-click reaches them. The gutter also re-renders as the PTY streams, so
    // re-resolve the trigger inside the poll (recount + re-pick mid) and retry the
    // force-click within the same 5s budget — a detach just retries cleanly.
    const gutterTriggers = gutter.locator('[aria-haspopup="dialog"]');
    const popover = page.locator('[data-radix-popper-content-wrapper]');
    await expect(async () => {
      const n = await gutterTriggers.count();
      const plusBtn = gutterTriggers.nth(Math.floor(n / 2));
      await plusBtn.scrollIntoViewIfNeeded().catch(() => {});
      await plusBtn.click({ force: true }).catch(() => {});
      await expect(popover).toBeVisible({ timeout: 800 });
    }).toPass({ timeout: 5_000 });

    // ── Step 3: Select "Bookmark" from the annotation type picker ─────────────
    await expect(popover).toBeVisible({ timeout: 5_000 });
    const bookmarkBtn = popover.getByText('Bookmark').first();
    await expect(bookmarkBtn).toBeVisible({ timeout: 3_000 });
    await bookmarkBtn.click();

    // ── Step 4: Fill bookmark textarea ─────────────────────────────────────────
    const textarea = page.locator('textarea[placeholder="Type a note..."]');
    await expect(textarea).toBeVisible({ timeout: 5_000 });
    await textarea.fill('e2e test bookmark');

    // ── Step 5: Save the bookmark ──────────────────────────────────────────────
    const saveBtn = popover.getByRole('button', { name: 'Save' });
    await expect(saveBtn).toBeEnabled({ timeout: 3_000 });
    await saveBtn.click();

    // URL must stay on the same process (no redirect away)
    expect(page.url()).toContain(processId);

    // ── Step 6: The bookmark ENTITY persists with correct session linkage ──────
    // Re-read from the backend (proves persistence, not just an optimistic UI
    // write) and assert it is linked to THIS process's worker session — the data
    // half of the old "resume the correct process" guard. The process's worker
    // session id is `agentic_process.session_id`; a terminal-annotation bookmark
    // carries it as `bookmark.session_id`.
    const bareProcessId = processId.replace('agentic_process-', '');
    // The process's worker session id is fixed data once present — resolve it
    // once, then poll only the bookmark endpoint for the persisted entity.
    let sessionId = '';
    await expect
      .poll(
        async () => {
          const procRes = await page.request.get(`${apiOrigin()}/api/v1/graph/agentic_process`);
          if (!procRes.ok()) return '';
          const procs = (await procRes.json()).data as Array<{ id: string; session_id?: string }>;
          sessionId = procs.find((p) => p.id === bareProcessId)?.session_id ?? '';
          return sessionId;
        },
        { timeout: 15_000, message: `agentic_process ${bareProcessId} persisted with a worker session id` },
      )
      .not.toBe('');

    // Find the bookmark bound to THIS process's worker session (there may be
    // other processes' bookmarks with the same content in an accumulated DB —
    // the session_id linkage is exactly what makes this one the right one).
    await expect(async () => {
      const bmRes = await page.request.get(`${apiOrigin()}/api/v1/graph/bookmark`);
      expect(bmRes.ok()).toBeTruthy();
      const bms = (await bmRes.json()).data as Array<{ session_id?: string; bookmark_type?: string; content?: string }>;
      const linked = bms.find((b) => b.session_id === sessionId && b.bookmark_type === 'terminal_annotation');
      expect(linked, `a terminal-annotation bookmark is linked to process session ${sessionId}`).toBeTruthy();
      expect(linked?.content, 'the linked bookmark carries the content we saved').toBe('e2e test bookmark');
    }).toPass({ timeout: 15_000 });

    // ── Step 7: A live surface lists the bookmark ─────────────────────────────
    // Reload the process page so the annotation gutter re-fetches bookmarks from
    // the backend (a full round-trip, not the in-memory state from creation) and
    // assert the persisted bookmark is rendered as a gutter marker cell. Hovering
    // it surfaces the stored content, confirming it is THIS bookmark.
    await page.goto(processUrl);
    await ensureAdvancedView(page);
    const gutterAfter = page.locator('[data-testid="annotation-gutter"]').first();
    await expect(gutterAfter).toBeAttached({ timeout: 30_000 });
    const bookmarkMarker = page.locator('[data-testid="annotation-cell-bookmark"]').first();
    await expect(bookmarkMarker).toBeVisible({ timeout: 15_000 });
    await bookmarkMarker.hover();
    await expect(page.getByText('e2e test bookmark').first()).toBeVisible({ timeout: 5_000 });
  });
});
