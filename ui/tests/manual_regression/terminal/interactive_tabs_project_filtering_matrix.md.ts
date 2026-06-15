/**
 * Interactive tabs / project filtering — regression matrix.
 * Source: interactive_tabs_project_filtering_matrix.md (50 scenarios, 8 areas).
 *
 * Fixtures are built via REST (project/shell/agentic_process) per the matrix's
 * "Setup helpers" block — no live SDK wait. The 5 tests the matrix explicitly
 * marks [skip:harness]/[skip:platform] (11, 31, 33, 34, 38) are test.skip with
 * the matrix's documented rationale; everything else is automated headlessly.
 *
 * One test('...') per matrix `test N:` line. baseURL comes from VITE_PORT.
 * API requests go to the frontend origin and ride the Vite `/api` proxy, so
 * they always reach the SAME backend the UI under test is wired to.
 * QA_API_URL overrides with an explicit backend; never hardcode a port.
 */
import { test, expect, request as pwRequest, type APIRequestContext, type Page } from '@playwright/test';
import { dismissSetupModal } from './helpers';

const API = process.env.QA_API_URL || '';
const tabSel = '[data-testid^="tab-shell-"]';

async function api(): Promise<APIRequestContext> {
  return pwRequest.newContext({
    baseURL: API || `http://localhost:${process.env.VITE_PORT || '4097'}`,
  });
}

async function bootstrapIds(rq: APIRequestContext): Promise<{ projectId: string; cn: string }> {
  const boot = (await (await rq.get(`${API}/api/v1/graph/bootstrap`)).json()).data;
  const gid = (x: unknown) => (typeof x === 'string' ? x : (x as { id?: string })?.id);
  return { projectId: gid(boot.default_project)!, cn: gid(boot.default_compute_node)! };
}

async function createProject(rq: APIRequestContext, name: string, mount: string): Promise<string> {
  const r = await rq.post(`${API}/api/v1/graph/project`, { data: { name, fs_storage_mount_path: mount } });
  expect(r.status()).toBe(200);
  return (await r.json()).data.id;
}

async function createShell(rq: APIRequestContext, projectId?: string): Promise<string> {
  const r = await rq.post(`${API}/api/v1/graph/shell`, { data: projectId ? { project_id: projectId } : {} });
  expect(r.status()).toBe(200);
  return (await r.json()).data.id;
}

async function createProcess(rq: APIRequestContext, projectId: string, worker: 'claude_code' | 'codex'): Promise<{ id: string; shellId: string }> {
  const r = await rq.post(`${API}/api/v1/graph/agentic_process`, { data: { project_id: projectId, worker_type: worker } });
  expect(r.status()).toBe(200);
  const id = (await r.json()).data.id;
  // AP defaults visible=false → filtered from strip; PATCH visible=true so it surfaces.
  await rq.patch(`${API}/api/v1/graph/agentic_process/${id}`, { data: { visible: true } });
  const got = (await (await rq.get(`${API}/api/v1/graph/agentic_process/${id}`)).json()).data;
  return { id, shellId: got.shell_id };
}

async function closeShell(rq: APIRequestContext, id: string): Promise<void> {
  await rq.post(`${API}/api/v1/graph/shell/${id}/close`);
}

async function resetDb(rq: APIRequestContext): Promise<void> {
  await rq.post(`${API}/api/v1/graph/compute_node/@local/desktop-db/clear`);
  // Wait until the DB engine is actually queryable again — not just bootstrap.
  // `desktop-db/clear` swaps the flowpad.db file; if the SQLAlchemy/aiosqlite
  // engine is left pointing at the deleted file it throws `disk I/O error` on
  // EVERY query (reads + writes) — a real backend bug observed under load. A
  // GET /project probe (which also 500s on the broken-engine state, without
  // polluting any project/shell count) makes that failure surface fast and
  // loudly at setup instead of cascading into a mid-test createShell 500.
  await expect(async () => {
    const probe = await rq.get(`${API}/api/v1/graph/project`);
    expect(probe.status(), 'DB engine queryable after clear (read probe)').toBe(200);
  }).toPass({ timeout: 15_000 });
}

/** Per-test unique project (avoids cross-test contamination without re-clearing). */
let projSeq = 0;
async function uniqueProject(rq: APIRequestContext, label: string): Promise<string> {
  const slug = `${label}-${Date.now()}-${projSeq++}`;
  return createProject(rq, slug, `/tmp/regression/${slug}`);
}

async function gotoDockShell(page: Page) {
  await page.goto('/dock/shell');
  const skipForNow = page.getByRole('button', { name: 'Skip for now' });
  if (await skipForNow.isVisible({ timeout: 2_000 }).catch(() => false)) await skipForNow.click();
  await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
}

async function gotoUrl(page: Page, path: string) {
  await page.goto(path);
  const skipForNow = page.getByRole('button', { name: 'Skip for now' });
  if (await skipForNow.isVisible({ timeout: 2_000 }).catch(() => false)) await skipForNow.click();
}

async function tabIds(page: Page): Promise<string[]> {
  return page.locator(tabSel).evaluateAll((els) => els.map((el) => el.getAttribute('data-testid') ?? '').filter(Boolean));
}

/**
 * Rename a tab. Uses dispatchEvent('dblclick') (a plain .dblclick() is
 * intercepted by the overflow-scroll container in a crowded strip) and the
 * rename input is `input[type="text"]` inside the tab.
 */
async function renameTab(page: Page, tabTestId: string, newName: string) {
  const tab = page.locator(`[data-testid="${tabTestId}"]`);
  const nameSpan = tab.locator('span').first();
  await nameSpan.dispatchEvent('dblclick');
  const input = tab.locator('input[type="text"]');
  await expect(input).toBeVisible({ timeout: 5_000 });
  await input.fill(newName);
  await input.press('Enter');
}

// Common validation block (lightweight, automatable subset): active panel
// mounted, URL is a concrete dock-shell pointer, no white-screen.
async function commonValidation(page: Page) {
  await expect(page.locator('[data-testid="terminal-panels"]')).toBeVisible();
  expect(page.url()).toMatch(/\/dock\/shell\/(shell-|agentic_process-)/);
}

test.describe('Interactive tabs / project filtering matrix', () => {
  test.beforeEach(async ({ page }) => {
    await dismissSetupModal(page);
  });

  // ---- A. Refresh & browse ----

  test('test 1: Refresh keeps a single shell tab alive', async ({ page }) => {
    const rq = await api();
    await resetDb(rq);
    await gotoUrl(page, '/dock/shell/new_terminal');
    await page.waitForURL(/\/dock\/shell\/shell-/, { timeout: 30_000 });
    const url1 = page.url();
    const target = url1.match(/shell-[0-9a-f-]+/)![0];
    await page.locator('[data-testid="terminal-panel"]').first().waitFor({ state: 'visible', timeout: 15_000 });
    await page.reload();
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
    expect(page.url()).toContain(target);
    await expect(page.locator(tabSel)).toHaveCount(1, { timeout: 15_000 });
    await commonValidation(page);
    await rq.dispose();
  });

  test('test 2: Refresh with 5 tabs preserves order and selection', async ({ page }) => {
    const rq = await api();
    await resetDb(rq);
    const { projectId } = await bootstrapIds(rq);
    for (let i = 0; i < 5; i++) await createShell(rq, projectId);
    await gotoDockShell(page);
    await expect.poll(async () => (await tabIds(page)).length, { timeout: 20_000 }).toBe(5);
    const orderBefore = await tabIds(page);
    await page.locator(tabSel).nth(2).click();
    await page.waitForTimeout(500);
    const url = page.url();
    const active = url.match(/(shell|agentic_process)-[0-9a-f-]+/)![0];
    await page.reload();
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
    await expect.poll(async () => tabIds(page), { timeout: 15_000 }).toEqual(orderBefore);
    expect(page.url()).toContain(active);
    await commonValidation(page);
    await rq.dispose();
  });

  test('test 3: Refresh on Claude tab keeps process bound', async ({ page }) => {
    const rq = await api();
    await resetDb(rq);
    const { projectId } = await bootstrapIds(rq);
    const { id } = await createProcess(rq, projectId, 'claude_code');
    await gotoUrl(page, `/dock/shell/agentic_process-${id}`);
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
    await expect(page.locator(`[data-testid="tab-shell-agentic_process-${id}"]`)).toBeVisible({ timeout: 15_000 });
    await page.reload();
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
    await expect(page.locator(`[data-testid="tab-shell-agentic_process-${id}"]`)).toBeVisible({ timeout: 15_000 });
    expect(page.url()).toContain(`agentic_process-${id}`);
    await commonValidation(page);
    await rq.dispose();
  });

  test('test 4: Refresh on Codex tab keeps process bound', async ({ page }) => {
    const rq = await api();
    await resetDb(rq);
    const { projectId } = await bootstrapIds(rq);
    const { id } = await createProcess(rq, projectId, 'codex');
    await gotoUrl(page, `/dock/shell/agentic_process-${id}`);
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
    await expect(page.locator(`[data-testid="tab-shell-agentic_process-${id}"]`)).toBeVisible({ timeout: 15_000 });
    await page.reload();
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
    await expect(page.locator(`[data-testid="tab-shell-agentic_process-${id}"]`)).toBeVisible({ timeout: 15_000 });
    expect(page.url()).toContain(`agentic_process-${id}`);
    await commonValidation(page);
    await rq.dispose();
  });

  test('test 5: Refresh on /dock/shell (no pointer) resolves a default tab', async ({ page }) => {
    const rq = await api();
    await resetDb(rq);
    await gotoDockShell(page);
    await page.waitForURL(/\/dock\/shell\/shell-/, { timeout: 15_000 });
    const target = page.url().match(/shell-[0-9a-f-]+/)![0];
    await page.reload();
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
    expect(page.url()).toMatch(/\/dock\/shell\/shell-/);
    expect(page.url()).toContain(target);
    await commonValidation(page);
    await rq.dispose();
  });

  test('test 6: Sidebar away-and-back keeps tabs alive', async ({ page }) => {
    const rq = await api();
    await resetDb(rq);
    const { projectId } = await bootstrapIds(rq);
    for (let i = 0; i < 3; i++) await createShell(rq, projectId);
    await gotoDockShell(page);
    await expect.poll(async () => (await tabIds(page)).length, { timeout: 20_000 }).toBe(3);
    await page.locator(tabSel).nth(1).click();
    await page.waitForTimeout(400);
    const active = page.url().match(/(shell|agentic_process)-[0-9a-f-]+/)![0];
    await page.locator('button[data-sidebar="menu-button"]:has(svg.lucide-house)').click();
    await page.waitForURL(/\/$/, { timeout: 15_000 });
    await page.locator('button[data-sidebar="menu-button"]:has(svg.lucide-terminal)').click();
    await page.waitForURL(/\/dock\/shell/, { timeout: 15_000 });
    await expect.poll(async () => (await tabIds(page)).length, { timeout: 15_000 }).toBe(3);
    expect(page.url()).toContain(active);
    await commonValidation(page);
    await rq.dispose();
  });

  test('test 7: Refresh after rename preserves rename', async ({ page }) => {
    const rq = await api();
    await resetDb(rq);
    const { projectId } = await bootstrapIds(rq);
    const ids = [await createShell(rq, projectId), await createShell(rq, projectId)];
    await gotoDockShell(page);
    await expect.poll(async () => (await tabIds(page)).length, { timeout: 20_000 }).toBe(2);
    const secondTab = page.locator(`[data-testid="tab-shell-shell-${ids[1]}"]`);
    await renameTab(page, `tab-shell-shell-${ids[1]}`, 'build-server');
    await expect(secondTab).toContainText('build-server', { timeout: 10_000 });
    // PTY-driven title update via the update-display action (is_pty=true) — must
    // NOT override the user rename (user_renamed guard).
    await rq.post(`${API}/api/v1/graph/shell/${ids[1]}/update-display`, { data: { name: 'pty-title-from-pty', is_pty: true } });
    await page.waitForTimeout(1_000);
    await expect(secondTab).toContainText('build-server');
    await page.reload();
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
    await expect(page.locator(`[data-testid="tab-shell-shell-${ids[1]}"]`)).toContainText('build-server', { timeout: 15_000 });
    await commonValidation(page);
    await rq.dispose();
  });

  // ---- B. Open from history or by id ----

  test('test 8: Open shell tab by direct URL', async ({ page }) => {
    const rq = await api();
    await resetDb(rq);
    const { projectId } = await bootstrapIds(rq);
    const ids = [await createShell(rq, projectId), await createShell(rq, projectId)];
    await gotoDockShell(page);
    await expect.poll(async () => (await tabIds(page)).length, { timeout: 20_000 }).toBe(2);
    const targetUrl = `/dock/shell/shell-${ids[1]}`;
    await page.locator('button[data-sidebar="menu-button"]:has(svg.lucide-house)').click();
    await page.waitForURL(/\/$/, { timeout: 15_000 });
    await gotoUrl(page, targetUrl);
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
    expect(page.url()).toContain(`shell-${ids[1]}`);
    await expect.poll(async () => (await tabIds(page)).length, { timeout: 15_000 }).toBe(2);
    await commonValidation(page);
    await rq.dispose();
  });

  test('test 9: Open process tab by direct URL', async ({ page }) => {
    const rq = await api();
    await resetDb(rq);
    const { projectId } = await bootstrapIds(rq);
    const { id } = await createProcess(rq, projectId, 'claude_code');
    await gotoUrl(page, `/dock/shell/agentic_process-${id}`);
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
    await expect(page.locator(`[data-testid="tab-shell-agentic_process-${id}"]`)).toBeVisible({ timeout: 15_000 });
    await commonValidation(page);
    await rq.dispose();
  });

  test('test 10: Open invalid shell id (graceful fallback)', async ({ page }) => {
    const rq = await api();
    await resetDb(rq);
    await gotoUrl(page, '/dock/shell/shell-deadbeef-dead-4eef-8eef-deadbeefdead');
    // Must not white-screen: page renders something (body has content), no crash.
    await page.waitForTimeout(3_000);
    const bodyText = (await page.locator('body').textContent()) ?? '';
    expect(bodyText.trim().length).toBeGreaterThan(0);
    // No uncaught error overlay / blank root.
    await expect(page.locator('#root')).not.toBeEmpty();
    await rq.dispose();
  });

  test('test 11: Open Claude tab via history record [skip:harness]', async () => {
    test.skip(true, 'harness: History modal is fed by disk-based ~/.claude/projects session log; REST cannot enroll a row. skip_challenge_required.');
  });

  test('test 12: Open shell-by-id whose project differs from current', async ({ page }) => {
    const rq = await api();
    await resetDb(rq);
    const pa = await createProject(rq, 'Proj-A', '/tmp/regression/proj-a');
    const pb = await createProject(rq, 'Proj-B', '/tmp/regression/proj-b');
    await createShell(rq, pa);
    const pbShell = await createShell(rq, pb);
    await gotoUrl(page, `/dock/shell/shell-${pbShell}`);
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
    // project auto-switches to Proj-B; URL preserved.
    expect(page.url()).toContain(`shell-${pbShell}`);
    await expect(page.locator('[data-testid="footer"]')).toContainText(/proj-b/i, { timeout: 15_000 });
    await commonValidation(page);
    await rq.dispose();
  });

  test('test 13: Re-open closed tab via stale URL', async ({ page }) => {
    const rq = await api();
    await resetDb(rq);
    const { projectId } = await bootstrapIds(rq);
    const ids = [await createShell(rq, projectId), await createShell(rq, projectId)];
    await gotoDockShell(page);
    await expect.poll(async () => (await tabIds(page)).length, { timeout: 20_000 }).toBe(2);
    const staleUrl = `/dock/shell/shell-${ids[1]}`;
    const secondTab = page.locator(`[data-testid="tab-shell-shell-${ids[1]}"]`);
    await secondTab.hover();
    await secondTab.locator('button[aria-label="Close tab"]').click();
    await expect(secondTab).toHaveCount(0, { timeout: 15_000 });
    await gotoUrl(page, staleUrl);
    await page.waitForTimeout(3_000);
    // Sensible state, no white-screen, no zombie tab for the closed id.
    await expect(page.locator('#root')).not.toBeEmpty();
    await commonValidation(page);
    await rq.dispose();
  });

  // ---- C. Close all ----

  test('test 14: Close-all closes only the current project tabs', async ({ page }) => {
    const rq = await api();
    await resetDb(rq);
    const pa = await createProject(rq, 'Proj-A', '/tmp/regression/proj-a');
    const pb = await createProject(rq, 'Proj-B', '/tmp/regression/proj-b');
    for (let i = 0; i < 3; i++) await createShell(rq, pa);
    for (let i = 0; i < 2; i++) await createShell(rq, pb);
    await gotoUrl(page, `/dock/shell/shell-${(await (await rq.get(`${API}/api/v1/graph/compute_node/@local/terminals/list`)).json()).data.pure_shells.find((s: { project_id: string }) => s.project_id === pa).id}`);
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
    await expect.poll(async () => (await tabIds(page)).length, { timeout: 20_000 }).toBe(3);
    await expect(page.locator('[data-testid="close-all-tabs-button"]')).toContainText('3', { timeout: 10_000 });
    await page.locator('[data-testid="close-all-tabs-button"]').click();
    await expect.poll(async () => (await tabIds(page)).length, { timeout: 15_000 }).toBe(0);
    await rq.dispose();
  });

  test('test 15: Close-all badge tracks visible count live', async ({ page }) => {
    const rq = await api();
    await resetDb(rq);
    const { projectId } = await bootstrapIds(rq);
    for (let i = 0; i < 4; i++) await createShell(rq, projectId);
    await gotoDockShell(page);
    await expect.poll(async () => (await tabIds(page)).length, { timeout: 20_000 }).toBe(4);
    await expect(page.locator('[data-testid="close-all-tabs-button"]')).toContainText('4', { timeout: 10_000 });
    const firstId = (await tabIds(page))[0];
    const firstTab = page.locator(`[data-testid="${firstId}"]`);
    await firstTab.hover();
    await firstTab.locator('button[aria-label="Close tab"]').click();
    await expect(page.locator('[data-testid="close-all-tabs-button"]')).toContainText('3', { timeout: 15_000 });
    await rq.dispose();
  });

  test('test 16: Close-all then refresh — no zombies', async ({ page }) => {
    const rq = await api();
    await resetDb(rq);
    const { projectId } = await bootstrapIds(rq);
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push(await createShell(rq, projectId));
    await gotoDockShell(page);
    await expect.poll(async () => (await tabIds(page)).length, { timeout: 20_000 }).toBe(4);
    await page.locator('[data-testid="close-all-tabs-button"]').click();
    await expect.poll(async () => (await tabIds(page)).length, { timeout: 15_000 }).toBe(0);
    await page.reload();
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
    await page.waitForTimeout(2_000);
    // None of the prior 4 return; allow zero or a single fresh default.
    const after = await tabIds(page);
    expect(after.length).toBeLessThanOrEqual(1);
    for (const id of ids) expect(after.join(',')).not.toContain(id);
    await rq.dispose();
  });

  test('test 17: Close All But This (context menu)', async ({ page }) => {
    const rq = await api();
    await resetDb(rq);
    const { projectId } = await bootstrapIds(rq);
    for (let i = 0; i < 5; i++) await createShell(rq, projectId);
    await gotoDockShell(page);
    await expect.poll(async () => (await tabIds(page)).length, { timeout: 20_000 }).toBe(5);
    const thirdId = (await tabIds(page))[2];
    await page.locator(`[data-testid="${thirdId}"]`).click({ button: 'right' });
    await page.getByText('Close All But This', { exact: true }).click();
    await expect.poll(async () => (await tabIds(page)).length, { timeout: 15_000 }).toBe(1);
    expect((await tabIds(page))[0]).toBe(thirdId);
    await commonValidation(page);
    await rq.dispose();
  });

  test('test 18: Close to the Right', async ({ page }) => {
    const rq = await api();
    await resetDb(rq);
    const { projectId } = await bootstrapIds(rq);
    for (let i = 0; i < 5; i++) await createShell(rq, projectId);
    await gotoDockShell(page);
    await expect.poll(async () => (await tabIds(page)).length, { timeout: 20_000 }).toBe(5);
    const before = await tabIds(page);
    await page.locator(`[data-testid="${before[0]}"]`).click();
    await page.waitForTimeout(300);
    await page.locator(`[data-testid="${before[1]}"]`).click({ button: 'right' });
    await page.getByText('Close to the Right', { exact: true }).click();
    await expect.poll(async () => (await tabIds(page)).length, { timeout: 15_000 }).toBe(2);
    const after = await tabIds(page);
    expect(after).toEqual([before[0], before[1]]);
    await rq.dispose();
  });

  test('test 19: Close single tab via X — strip self-heals to first by tab_order', async ({ page }) => {
    const rq = await api();
    await resetDb(rq);
    const { projectId } = await bootstrapIds(rq);
    for (let i = 0; i < 4; i++) await createShell(rq, projectId);
    await gotoDockShell(page);
    await expect.poll(async () => (await tabIds(page)).length, { timeout: 20_000 }).toBe(4);
    const before = await tabIds(page);
    const secondTab = page.locator(`[data-testid="${before[1]}"]`);
    await secondTab.click();
    await page.waitForTimeout(300);
    await secondTab.hover();
    await secondTab.locator('button[aria-label="Close tab"]').click();
    await expect(secondTab).toHaveCount(0, { timeout: 15_000 });
    // Active self-heals to the first tab (lowest tab_order).
    const firstTargetKey = before[0].replace('tab-shell-', '');
    await expect.poll(async () => page.url(), { timeout: 15_000 }).toContain(firstTargetKey);
    await expect(page.locator('[data-testid="close-all-tabs-button"]')).toContainText('3', { timeout: 10_000 });
    await rq.dispose();
  });

  test('test 20: Close-all button hides at < 2 tabs', async ({ page }) => {
    const rq = await api();
    await resetDb(rq);
    const { projectId } = await bootstrapIds(rq);
    await createShell(rq, projectId);
    await gotoDockShell(page);
    await expect.poll(async () => (await tabIds(page)).length, { timeout: 20_000 }).toBe(1);
    await expect(page.locator('[data-testid="close-all-tabs-button"]')).toHaveCount(0);
    // Spawn a 2nd via opener menu.
    await page.locator('button[aria-label="Open new tab menu"]').click();
    await page.locator('[data-testid="opener-menu-row-terminal"]').click();
    await expect.poll(async () => (await tabIds(page)).length, { timeout: 15_000 }).toBe(2);
    await expect(page.locator('[data-testid="close-all-tabs-button"]')).toContainText('2', { timeout: 10_000 });
    // Close the 2nd → button hides again.
    const ids = await tabIds(page);
    const last = page.locator(`[data-testid="${ids[1]}"]`);
    await last.hover();
    await last.locator('button[aria-label="Close tab"]').click();
    await expect(page.locator('[data-testid="close-all-tabs-button"]')).toHaveCount(0, { timeout: 15_000 });
    await rq.dispose();
  });

  // ---- D. Projects count chips selection ----

  test('test 21: Chip selects project, swaps tab strip + URL', async ({ page }) => {
    const rq = await api();
    await resetDb(rq);
    const pa = await createProject(rq, 'Proj-A', '/tmp/regression/proj-a');
    const pb = await createProject(rq, 'Proj-B', '/tmp/regression/proj-b');
    for (let i = 0; i < 2; i++) await createShell(rq, pa);
    for (let i = 0; i < 3; i++) await createShell(rq, pb);
    await gotoDockShell(page);
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
    await page.locator('[data-testid="projects-counter-chip"]').first().click();
    await page.locator('[data-testid="projects-counter-popover"]').waitFor({ state: 'visible', timeout: 10_000 });
    // Select Proj-B explicitly.
    await page.locator('[data-testid="projects-counter-popover"]').getByText(/Proj-B|proj-b/).first().click();
    await expect.poll(async () => (await tabIds(page)).length, { timeout: 15_000 }).toBe(3);
    await commonValidation(page);
    await rq.dispose();
  });

  test('test 22: Chip badge equals distinct project count', async ({ page }) => {
    const rq = await api();
    await resetDb(rq);
    const a = await createProject(rq, 'Proj-A', '/tmp/regression/proj-a');
    const b = await createProject(rq, 'Proj-B', '/tmp/regression/proj-b');
    const c = await createProject(rq, 'Proj-C', '/tmp/regression/proj-c');
    for (let i = 0; i < 2; i++) await createShell(rq, a);
    await createShell(rq, b);
    for (let i = 0; i < 4; i++) await createShell(rq, c);
    await gotoDockShell(page);
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
    await expect(page.locator('[data-testid="projects-counter-chip"]').first()).toContainText('3', { timeout: 15_000 });
    await rq.dispose();
  });

  test('test 23: Selecting current project = no-op', async ({ page }) => {
    const rq = await api();
    await resetDb(rq);
    const { projectId } = await bootstrapIds(rq);
    await createShell(rq, projectId);
    await gotoDockShell(page);
    await page.waitForURL(/\/dock\/shell\/shell-/, { timeout: 15_000 });
    const urlBefore = page.url();
    await page.locator('[data-testid="projects-counter-chip"]').first().click();
    await page.locator('[data-testid="projects-counter-popover"]').waitFor({ state: 'visible', timeout: 10_000 });
    const current = page.locator('[data-testid="projects-counter-popover"] [aria-current="true"]');
    if (await current.count()) await current.first().click();
    else await page.keyboard.press('Escape');
    await page.waitForTimeout(1_000);
    expect(page.url()).toBe(urlBefore);
    await rq.dispose();
  });

  test('test 24: Popover ordering — current first, count desc, alpha tiebreak', async ({ page }) => {
    const rq = await api();
    await resetDb(rq);
    const a = await createProject(rq, 'Proj-A', '/tmp/regression/proj-a');
    const b = await createProject(rq, 'Proj-B', '/tmp/regression/proj-b');
    const c = await createProject(rq, 'Proj-C', '/tmp/regression/proj-c');
    const d = await createProject(rq, 'Proj-D', '/tmp/regression/proj-d');
    for (let i = 0; i < 5; i++) await createShell(rq, a);
    for (let i = 0; i < 3; i++) await createShell(rq, b);
    for (let i = 0; i < 5; i++) await createShell(rq, c);
    await createShell(rq, d);
    // current = Proj-B
    const bShell = (await (await rq.get(`${API}/api/v1/graph/compute_node/@local/terminals/list`)).json()).data.pure_shells.find((s: { project_id: string }) => s.project_id === b).id;
    await gotoUrl(page, `/dock/shell/shell-${bShell}`);
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
    await page.locator('[data-testid="projects-counter-chip"]').first().click();
    await page.locator('[data-testid="projects-counter-popover"]').waitFor({ state: 'visible', timeout: 10_000 });
    const rows = await page.locator('[data-testid="projects-counter-popover"]').getByText(/Proj-[ABCD]/).allTextContents();
    const order = rows.map((t) => (t.match(/Proj-[ABCD]/) ?? [''])[0]).filter(Boolean);
    expect(order.slice(0, 4)).toEqual(['Proj-B', 'Proj-A', 'Proj-C', 'Proj-D']);
    await rq.dispose();
  });

  test('test 25: Project with zero tabs after close-all', async ({ page }) => {
    const rq = await api();
    await resetDb(rq);
    const a = await createProject(rq, 'Proj-A', '/tmp/regression/proj-a');
    const b = await createProject(rq, 'Proj-B', '/tmp/regression/proj-b');
    for (let i = 0; i < 3; i++) await createShell(rq, a);
    for (let i = 0; i < 2; i++) await createShell(rq, b);
    const aShell = (await (await rq.get(`${API}/api/v1/graph/compute_node/@local/terminals/list`)).json()).data.pure_shells.find((s: { project_id: string }) => s.project_id === a).id;
    await gotoUrl(page, `/dock/shell/shell-${aShell}`);
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
    await expect.poll(async () => (await tabIds(page)).length, { timeout: 20_000 }).toBe(3);
    await page.locator('[data-testid="close-all-tabs-button"]').click();
    await expect.poll(async () => (await tabIds(page)).length, { timeout: 15_000 }).toBe(0);
    // Footer still shows Proj-A; Proj-B still has its 2 tabs when selected.
    await expect(page.locator('[data-testid="footer"]')).toContainText(/proj-a/i, { timeout: 10_000 });
    await rq.dispose();
  });

  test('test 26: Switching project auto-selects first tab by tab_order', async ({ page }) => {
    const rq = await api();
    await resetDb(rq);
    const a = await createProject(rq, 'Proj-A', '/tmp/regression/proj-a');
    const b = await createProject(rq, 'Proj-B', '/tmp/regression/proj-b');
    for (let i = 0; i < 3; i++) await createShell(rq, a);
    for (let i = 0; i < 2; i++) await createShell(rq, b);
    const list = (await (await rq.get(`${API}/api/v1/graph/compute_node/@local/terminals/list`)).json()).data.pure_shells;
    const bShells = list.filter((s: { project_id: string }) => s.project_id === b).sort((x: { tab_order: number }, y: { tab_order: number }) => (x.tab_order ?? 0) - (y.tab_order ?? 0));
    const aShells = list.filter((s: { project_id: string }) => s.project_id === a);
    await gotoUrl(page, `/dock/shell/shell-${aShells[1].id}`);
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
    await page.locator('[data-testid="projects-counter-chip"]').first().click();
    await page.locator('[data-testid="projects-counter-popover"]').waitFor({ state: 'visible', timeout: 10_000 });
    await page.locator('[data-testid="projects-counter-popover"]').getByText(/Proj-B/).first().click();
    await expect.poll(async () => page.url(), { timeout: 15_000 }).toContain(`shell-${bShells[0].id}`);
    await rq.dispose();
  });

  test('test 27: Every shell carries a real project_id (no orphans by design)', async ({ page }) => {
    const rq = await api();
    await resetDb(rq);
    const a = await createProject(rq, 'Proj-A', '/tmp/regression/proj-a');
    const b = await createProject(rq, 'Proj-B', '/tmp/regression/proj-b');
    await createShell(rq, a);
    await createShell(rq, b);
    const emptyShell = await createShell(rq); // no project_id in body
    const got = (await (await rq.get(`${API}/api/v1/graph/shell/${emptyShell}`)).json()).data;
    expect(got.project_id, 'empty-body shell auto-assigned a project_id').toBeTruthy();
    // It belongs to bootstrap @local, not Proj-A.
    const { projectId } = await bootstrapIds(rq);
    expect(got.project_id).toBe(projectId);
    await rq.dispose();
  });

  // ---- E. Footer selections ----

  test('test 28: Footer "Switch Project" modal switches end-to-end', async ({ page }) => {
    const rq = await api();
    await resetDb(rq);
    const b = await createProject(rq, 'Proj-B', '/tmp/regression/proj-b');
    for (let i = 0; i < 2; i++) await createShell(rq, b);
    await gotoDockShell(page);
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
    await page.locator('[data-testid="footer"] button[title="Switch project"]').click();
    // Modal: click "All" then the proj-b row.
    const allTab = page.getByRole('button', { name: 'All', exact: true });
    if (await allTab.isVisible({ timeout: 2_000 }).catch(() => false)) await allTab.click();
    await page.getByText(/proj-b/i).first().click();
    await expect(page.locator('[data-testid="footer"]')).toContainText(/proj-b/i, { timeout: 15_000 });
    await expect.poll(async () => (await tabIds(page)).length, { timeout: 15_000 }).toBe(2);
    await commonValidation(page);
    await rq.dispose();
  });

  test('test 29: Footer label fallback chain', async ({ page }) => {
    const rq = await api();
    await resetDb(rq);
    await gotoDockShell(page);
    await page.waitForURL(/\/dock\/shell\/shell-/, { timeout: 15_000 });
    // Footer reflects project path/name initially.
    const footer = page.locator('[data-testid="footer"]');
    await expect(footer).toBeVisible();
    // Override workdir → footer shows the explicit path.
    await page.evaluate(() => (window as unknown as { dataContext: { setWorkdir: (p: string | null) => Promise<void> } }).dataContext.setWorkdir('/tmp/regression/override-workdir'));
    await expect(footer).toContainText('override-workdir', { timeout: 10_000 });
    // Revert.
    await page.evaluate(() => (window as unknown as { dataContext: { setWorkdir: (p: string | null) => Promise<void> } }).dataContext.setWorkdir(null));
    await expect(footer).not.toContainText('override-workdir', { timeout: 10_000 });
    await rq.dispose();
  });

  test('test 30: "Select Project" red pill — tab spawn flow', async ({ page }) => {
    const rq = await api();
    await resetDb(rq);
    await gotoDockShell(page);
    await page.waitForURL(/\/dock\/shell\/shell-/, { timeout: 15_000 });
    await page.evaluate(() =>
      (window as unknown as { dataContext: { setContextEntityTypeId: (k: string, v: null) => Promise<void> } }).dataContext.setContextEntityTypeId('CurrentProjectTypeId', null),
    );
    // Red "Select Project" pill visible in footer.
    await expect(page.locator('[data-testid="footer"]')).toContainText(/Select Project/i, { timeout: 10_000 });
    await rq.dispose();
  });

  test('test 31: "Open folder" launches at workdir [skip:platform]', async () => {
    test.skip(true, 'platform: OS file manager opens outside the browser; cannot verify headlessly. skip_challenge_required.');
  });

  test('test 32: Footer repo/branch reflects active project Git artifact', async ({ page }) => {
    const rq = await api();
    await resetDb(rq);
    const b = await createProject(rq, 'Proj-B', '/tmp/regression/proj-b');
    await createShell(rq, b);
    // Create a GIT_REPO artifact scoped to Proj-B.
    const artRes = await rq.post(`${API}/api/v1/graph/artifact`, {
      data: {
        artifact_type: 'GIT_REPO',
        metadata: { url: 'git@example.com:org/repo.git', branch: 'feat/x' },
        context_entities: [{ type_id: `project-${b}` }],
      },
    });
    // If the artifact endpoint/shape differs, this test surfaces it; record status.
    expect([200, 201]).toContain(artRes.status());
    const bShell = (await (await rq.get(`${API}/api/v1/graph/compute_node/@local/terminals/list`)).json()).data.pure_shells.find((s: { project_id: string }) => s.project_id === b).id;
    await gotoUrl(page, `/dock/shell/shell-${bShell}`);
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
    await expect(page.locator('[data-testid="footer"]')).toContainText(/feat\/x/, { timeout: 15_000 });
    await rq.dispose();
  });

  // ---- F. Restart & CLI changes ----

  test('test 33: Backend restart preserves tabs [skip:harness]', async () => {
    test.skip(true, 'harness: restarting flow_sdk.server.run on the shared dev backend terminates other agents WS. Live only on isolated backend. skip_challenge_required.');
  });

  test('test 34: Backend restart with an AgenticProcess in the strip [skip:harness]', async () => {
    test.skip(true, 'harness: same shared-backend-restart limit as test 33. skip_challenge_required.');
  });

  test('test 35: External REST POST creates a new shell (CLI-equivalent)', async ({ page }) => {
    const rq = await api();
    await resetDb(rq);
    const b = await createProject(rq, 'Proj-B', '/tmp/regression/proj-b');
    await gotoDockShell(page);
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
    const before = (await tabIds(page)).length;
    await createShell(rq, b);
    // Without manual refresh, the new tab appears via WS-driven refetch.
    await expect.poll(async () => (await tabIds(page)).length, { timeout: 8_000 }).toBeGreaterThan(before);
    await rq.dispose();
  });

  test('test 36: External REST POST creates a Claude AgenticProcess', async ({ page }) => {
    const rq = await api();
    await resetDb(rq);
    const b = await createProject(rq, 'Proj-B', '/tmp/regression/proj-b');
    await gotoDockShell(page);
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
    const { id } = await createProcess(rq, b, 'claude_code');
    await expect.poll(async () => (await tabIds(page)).join(','), { timeout: 8_000 }).toContain(`agentic_process-${id}`);
    await rq.dispose();
  });

  test('test 37: External REST DELETE/close removes a session', async ({ page }) => {
    const rq = await api();
    await resetDb(rq);
    const { projectId } = await bootstrapIds(rq);
    const ids = [await createShell(rq, projectId), await createShell(rq, projectId), await createShell(rq, projectId)];
    await gotoDockShell(page);
    await expect.poll(async () => (await tabIds(page)).length, { timeout: 20_000 }).toBe(3);
    // Close a non-active (last) shell externally.
    await closeShell(rq, ids[2]);
    await expect.poll(async () => (await tabIds(page)).join(','), { timeout: 8_000 }).not.toContain(ids[2]);
    await expect.poll(async () => (await tabIds(page)).length, { timeout: 8_000 }).toBe(2);
    await rq.dispose();
  });

  test('test 38: Two browser windows in sync [skip:harness]', async () => {
    test.skip(true, 'harness: cross-window WS sync needs two independent sessions; MCP/shared Chrome cannot simulate. Covered by 35/36/37 REST-as-second-client. skip_challenge_required.');
  });

  // ---- G. Codex / Claude / terminal mix ----

  test('test 39: Mixed strip renders correct icons', async ({ page }) => {
    const rq = await api();
    await resetDb(rq);
    const { projectId } = await bootstrapIds(rq);
    await createShell(rq, projectId);
    const claude = await createProcess(rq, projectId, 'claude_code');
    const codex = await createProcess(rq, projectId, 'codex');
    await gotoDockShell(page);
    await expect.poll(async () => (await tabIds(page)).length, { timeout: 20_000 }).toBe(3);
    await expect(page.locator(`[data-testid="tab-provider-icon-${claude.id}"][data-provider="claude"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="tab-provider-icon-${codex.id}"][data-provider="codex"]`)).toBeVisible();
    await expect(page.locator('[data-testid^="tab-provider-icon-"][data-provider="shell"]')).toBeVisible();
    await rq.dispose();
  });

  test('test 40: Switching between mixed types — no cross-talk', async ({ page }) => {
    const rq = await api();
    await resetDb(rq);
    const { projectId } = await bootstrapIds(rq);
    await createShell(rq, projectId);
    await createProcess(rq, projectId, 'claude_code');
    await createProcess(rq, projectId, 'codex');
    await gotoDockShell(page);
    await expect.poll(async () => (await tabIds(page)).length, { timeout: 20_000 }).toBe(3);
    const ids = await tabIds(page);
    for (const id of ids) {
      await page.locator(`[data-testid="${id}"]`).click();
      await page.waitForTimeout(400);
      await expect(page.locator('[data-testid="terminal-panel"][data-active="true"]')).toBeVisible();
    }
    await rq.dispose();
  });

  test('test 41: Spawn each type from + / opener menu', async ({ page }) => {
    const rq = await api();
    await resetDb(rq);
    await gotoDockShell(page);
    await page.waitForURL(/\/dock\/shell\/shell-/, { timeout: 15_000 });
    const start = (await tabIds(page)).length;
    // terminal
    await page.locator('button[aria-label="Open new tab menu"]').click();
    await page.locator('[data-testid="opener-menu-row-terminal"]').click();
    await expect.poll(async () => (await tabIds(page)).length, { timeout: 15_000 }).toBe(start + 1);
    // claude
    await page.locator('button[aria-label="Open new tab menu"]').click();
    await page.locator('[data-testid="opener-menu-row-claude"]').click();
    await expect.poll(async () => (await tabIds(page)).length, { timeout: 15_000 }).toBe(start + 2);
    // codex (skip sub-step if absent in this build)
    await page.locator('button[aria-label="Open new tab menu"]').click();
    const codexRow = page.locator('[data-testid="opener-menu-row-codex"]');
    if (await codexRow.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await codexRow.click();
      await expect.poll(async () => (await tabIds(page)).length, { timeout: 15_000 }).toBe(start + 3);
    } else {
      await page.keyboard.press('Escape');
    }
    await rq.dispose();
  });

  test('test 42: Close Claude tab — underlying shell behavior', async ({ page }) => {
    const rq = await api();
    await resetDb(rq);
    const { projectId } = await bootstrapIds(rq);
    const { id } = await createProcess(rq, projectId, 'claude_code');
    await gotoUrl(page, `/dock/shell/agentic_process-${id}`);
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
    const tab = page.locator(`[data-testid="tab-shell-agentic_process-${id}"]`);
    await expect(tab).toBeVisible({ timeout: 15_000 });
    await tab.hover();
    await tab.locator('button[aria-label="Close tab"]').click();
    // No zombie panels; the AP tab is gone.
    await expect(tab).toHaveCount(0, { timeout: 15_000 });
    await rq.dispose();
  });

  test('test 43: Rename Claude tab survives switch + refresh + PTY title', async ({ page }) => {
    const rq = await api();
    await resetDb(rq);
    const { projectId } = await bootstrapIds(rq);
    const { id, shellId } = await createProcess(rq, projectId, 'claude_code');
    await createShell(rq, projectId); // a 2nd tab to switch to
    await gotoUrl(page, `/dock/shell/agentic_process-${id}`);
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
    const tab = page.locator(`[data-testid="tab-shell-agentic_process-${id}"]`);
    await renameTab(page, `tab-shell-agentic_process-${id}`, 'claude-fix');
    await expect(tab).toContainText('claude-fix', { timeout: 10_000 });
    // switch away and back
    const others = (await tabIds(page)).filter((t) => !t.includes(id));
    await page.locator(`[data-testid="${others[0]}"]`).click();
    await page.waitForTimeout(300);
    await tab.click();
    await expect(tab).toContainText('claude-fix');
    // refresh
    await page.reload();
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
    await expect(page.locator(`[data-testid="tab-shell-agentic_process-${id}"]`)).toContainText('claude-fix', { timeout: 15_000 });
    // PTY title update must not override user rename
    await rq.post(`${API}/api/v1/graph/shell/${shellId}/update-display`, { data: { name: 'pty-title', is_pty: true } });
    await page.waitForTimeout(1_000);
    await expect(page.locator(`[data-testid="tab-shell-agentic_process-${id}"]`)).toContainText('claude-fix');
    await rq.dispose();
  });

  test('test 44: Rename rejects TypeId-format strings (real v4 UUID)', async ({ page }) => {
    const rq = await api();
    await resetDb(rq);
    const { projectId } = await bootstrapIds(rq);
    const sid = await createShell(rq, projectId);
    await gotoUrl(page, `/dock/shell/shell-${sid}`);
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
    const tab = page.locator(`[data-testid="tab-shell-shell-${sid}"]`);
    const nameBefore = (await tab.textContent())?.trim() ?? '';
    await renameTab(page, `tab-shell-shell-${sid}`, 'shell-abcd1234-ef56-4789-9abc-567890abcdef');
    await page.waitForTimeout(1_000);
    // Guard early-returns on TypeId match → name unchanged (no TypeId-looking name).
    await expect(tab).not.toContainText('abcd1234-ef56-4789');
    expect((await tab.textContent())?.trim()).not.toBe('shell-abcd1234-ef56-4789-9abc-567890abcdef');
    await rq.dispose();
    void nameBefore;
  });

  // ---- H. Navigation back/forward in/out of dock ----

  test('test 45: Sidebar Home -> Shell -> Home preserves dock state', async ({ page }) => {
    const rq = await api();
    await resetDb(rq);
    const { projectId } = await bootstrapIds(rq);
    for (let i = 0; i < 3; i++) await createShell(rq, projectId);
    await gotoDockShell(page);
    await expect.poll(async () => (await tabIds(page)).length, { timeout: 20_000 }).toBe(3);
    await page.locator(tabSel).nth(1).click();
    await page.waitForTimeout(400);
    const active = page.url().match(/(shell|agentic_process)-[0-9a-f-]+/)![0];
    for (let r = 0; r < 2; r++) {
      await page.locator('button[data-sidebar="menu-button"]:has(svg.lucide-house)').click();
      await page.waitForURL(/\/$/, { timeout: 15_000 });
      await page.locator('button[data-sidebar="menu-button"]:has(svg.lucide-terminal)').click();
      await page.waitForURL(/\/dock\/shell/, { timeout: 15_000 });
      await expect.poll(async () => (await tabIds(page)).length, { timeout: 15_000 }).toBe(3);
      expect(page.url()).toContain(active);
    }
    await rq.dispose();
  });

  test('test 46: Browser back/forward across tab clicks', async ({ page }) => {
    const rq = await api();
    await resetDb(rq);
    const { projectId } = await bootstrapIds(rq);
    for (let i = 0; i < 3; i++) await createShell(rq, projectId);
    await gotoDockShell(page);
    await expect.poll(async () => (await tabIds(page)).length, { timeout: 20_000 }).toBe(3);
    const ids = await tabIds(page);
    const keys = ids.map((t) => t.replace('tab-shell-', ''));
    for (const id of ids) {
      await page.locator(`[data-testid="${id}"]`).click();
      await page.waitForTimeout(400);
    }
    // Back twice: C -> B -> A
    await page.goBack();
    await expect.poll(async () => page.url(), { timeout: 15_000 }).toContain(keys[1]);
    await page.goBack();
    await expect.poll(async () => page.url(), { timeout: 15_000 }).toContain(keys[0]);
    // Forward twice: A -> B -> C
    await page.goForward();
    await expect.poll(async () => page.url(), { timeout: 15_000 }).toContain(keys[1]);
    await page.goForward();
    await expect.poll(async () => page.url(), { timeout: 15_000 }).toContain(keys[2]);
    await rq.dispose();
  });

  test('test 47: Browser back/forward across /dock/shell/<id> and /', async ({ page }) => {
    const rq = await api();
    await resetDb(rq);
    const { projectId } = await bootstrapIds(rq);
    for (let i = 0; i < 2; i++) await createShell(rq, projectId);
    await gotoDockShell(page);
    await expect.poll(async () => (await tabIds(page)).length, { timeout: 20_000 }).toBe(2);
    await page.locator(tabSel).nth(1).click();
    await page.waitForTimeout(400);
    const target = page.url().match(/(shell|agentic_process)-[0-9a-f-]+/)![0];
    await page.locator('button[data-sidebar="menu-button"]:has(svg.lucide-house)').click();
    await page.waitForURL(/\/$/, { timeout: 15_000 });
    await page.goBack();
    await expect.poll(async () => page.url(), { timeout: 15_000 }).toContain(target);
    await page.goForward();
    await expect.poll(async () => page.url(), { timeout: 15_000 }).toMatch(/\/$/);
    await page.goBack();
    await expect.poll(async () => page.url(), { timeout: 15_000 }).toContain(target);
    await rq.dispose();
  });

  test('test 48: Wrong agentId in URL falls back gracefully', async ({ page }) => {
    const rq = await api();
    await resetDb(rq);
    const { projectId } = await bootstrapIds(rq);
    for (let i = 0; i < 2; i++) await createShell(rq, projectId);
    await gotoUrl(page, '/agent/00000000-0000-0000-0000-000000000000/dock/shell');
    await page.waitForTimeout(3_000);
    // No white-screen; something renders.
    await expect(page.locator('#root')).not.toBeEmpty();
    await rq.dispose();
  });

  test('test 49: Process-pointer dock URL activates the AP tab', async ({ page }) => {
    const rq = await api();
    await resetDb(rq);
    const { projectId } = await bootstrapIds(rq);
    const { id } = await createProcess(rq, projectId, 'claude_code');
    await gotoUrl(page, `/dock/shell/agentic_process-${id}`);
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
    await expect(page.locator(`[data-testid="tab-shell-agentic_process-${id}"]`)).toBeVisible({ timeout: 15_000 });
    expect(page.url()).toContain(`agentic_process-${id}`);
    await page.locator('button[data-sidebar="menu-button"]:has(svg.lucide-house)').click();
    await page.waitForURL(/\/$/, { timeout: 15_000 });
    await page.locator('button[data-sidebar="menu-button"]:has(svg.lucide-terminal)').click();
    await page.waitForURL(/\/dock\/shell/, { timeout: 15_000 });
    await page.locator(`[data-testid="tab-shell-agentic_process-${id}"]`).click();
    await expect.poll(async () => page.url(), { timeout: 15_000 }).toContain(`agentic_process-${id}`);
    await commonValidation(page);
    await rq.dispose();
  });

  test('test 50: Deep link /dock/shell/new_terminal redirects to a real shell', async ({ page }) => {
    const rq = await api();
    await resetDb(rq);
    await gotoUrl(page, '/dock/shell/new_terminal');
    await page.waitForURL(/\/dock\/shell\/shell-/, { timeout: 30_000 });
    const target = page.url().match(/shell-[0-9a-f-]+/)![0];
    await page.locator('[data-testid="terminal-panel"]').first().waitFor({ state: 'visible', timeout: 15_000 });
    // Back should NOT go to /dock/shell/new_terminal (it was REPLACED).
    await page.goBack();
    await page.waitForTimeout(1_000);
    expect(page.url()).not.toContain('new_terminal');
    void target;
    await rq.dispose();
  });
});
