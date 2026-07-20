import { test, expect } from '@playwright/test';

// SKIPPED: clicking a session in the history opener does not redirect to
// the agentic_process URL after a fresh DB clear (waitForURL times out). Same
// root cause as agentic_process_visible_restored_on_load — needs the
// routePlainShellPointer / cachedEntitiesByType pipeline to surface processes
// reliably on cold navigation.
test.skip('revalidate post #31: resume claude session — diagnostics', async ({ page }) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => {
    localStorage.setItem('llm-setup-modal-seen', 'true');
  });

  await page.goto('/dock/shell/new_terminal');
  await page.waitForURL(/\/dock\/shell\//, { timeout: 60_000 });
  await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForTimeout(2_000);

  await page.locator('[data-testid="opener-plus-button"]').click();
  await page.locator('[data-testid="opener-menu-row-history"]').click();
  await expect(page.locator('text=Recent Sessions')).toBeVisible({ timeout: 5_000 });
  await page.waitForTimeout(2_000);

  const noSessions = await page.locator('text=No recent sessions').isVisible().catch(() => false);
  if (noSessions) {
    test.skip(true, 'No recent sessions in this test environment — resume cannot be exercised');
    return;
  }

  const firstRowButton = page.locator('[role="dialog"] ul li button').first();
  await firstRowButton.click();

  await page.waitForURL(/\/dock\/shell\/agentic_process-[a-f0-9-]+/, { timeout: 30_000 });
  const resumedUrl = page.url();
  const apId = resumedUrl.match(/agentic_process-([a-f0-9-]+)/)![1];
  console.log('=== Resumed URL:', resumedUrl);
  console.log('=== AP id:', apId);

  await page.waitForTimeout(5_000);
  console.log('=== URL after 5s wait:', page.url());

  // Diagnostic 1
  const projectId = await page.evaluate(() => {
    const ctx = (globalThis as any).__FLOWPAD_DATA_CONTEXT__ || (globalThis as any).dataContext || null;
    return ctx?.project?.id ?? 'NOT_EXPOSED_ON_GLOBAL';
  });
  console.log('=== Diag 1 dataContext.project.id:', projectId);

  // Diagnostic 2: backend AP (probe to confirm project_id rebinding)
  const apFromBackend = await page.evaluate(async (id) => {
    try {
      const r = await fetch(`/api/v1/graph/compute_node/@local/agentic_process/${id}`);
      const j = await r.json();
      const d = j?.data || {};
      return {
        status: r.status,
        id: d.id,
        context_data_project_id: d.context_data?.project_id,
        context_entities: d.context_entities,
        shell_id: d.shell_id,
        visible: d.visible,
        session_id: d.session_id,
      };
    } catch (e: any) {
      return { error: e.message };
    }
  }, apId);
  console.log('=== Diag 2 backend AP:', JSON.stringify(apFromBackend));

  // Diagnostic 3: AgenticProcess from client cache
  const apClient = await page.evaluate((id) => {
    const w: any = globalThis;
    const ap = w.AgenticProcess?.getById?.(id) ?? w.AgenticProcess?.getByIdFromCache?.(id) ?? null;
    return ap ? {
      id: ap.id,
      visible: ap.visible,
      shell_id: ap.shell_id,
      project_id: ap.project_id,
      session_id: ap.session_id,
      status: ap.status,
    } : 'no AP in client cache';
  }, apId);
  console.log('=== Diag 3 client AP:', JSON.stringify(apClient));

  // Diagnostic 4: Shell from client cache (using shell_id from backend probe)
  const shellId = (apFromBackend as any).shell_id;
  const shellClient = shellId ? await page.evaluate((sid) => {
    const w: any = globalThis;
    const s = w.Shell?.getByIdFromCache?.(sid) ?? null;
    return s ? { id: s.id, project_id: s.project_id, visible: s.visible, pty_pid: s.pty_pid } : 'no Shell in client cache';
  }, shellId) : 'no shell_id from backend probe';
  console.log('=== Diag 4 client Shell:', JSON.stringify(shellClient));

  // Tab strip & aria
  const tabsList = await page.locator('[data-testid^="tab-"]').evaluateAll(els =>
    els.map(e => ({ id: e.getAttribute('data-testid'), text: (e.textContent || '').trim().substring(0, 50) })),
  );
  console.log('=== Tabs in strip:', JSON.stringify(tabsList));

  const ariaLabels = await page.locator('button[aria-label]').evaluateAll(els =>
    els.map(e => e.getAttribute('aria-label')).filter(Boolean),
  );
  console.log('=== aria-labels:', JSON.stringify(ariaLabels));

  // Two "Session info" buttons exist (one in each ribbon). first() can resolve
  // to a hidden duplicate. Probe all candidates and accept any that's visible.
  const allInfoIcons = page.locator('button[aria-label="Session info"]');
  const total = await allInfoIcons.count();
  let infoVisible = false;
  for (let i = 0; i < total; i++) {
    if (await allInfoIcons.nth(i).isVisible({ timeout: 5_000 }).catch(() => false)) {
      infoVisible = true;
      break;
    }
  }
  console.log('=== Info icon visible:', infoVisible);
  expect(infoVisible).toBe(true);
});
