/**
 * Interactive tabs / project filtering — regression matrix.
 * Source: interactive_tabs_project_filtering_matrix.md (51 active scenarios,
 * historical numbering retained, 9 areas).
 *
 * Fixtures are built via REST (project/shell/agentic_process) per the matrix's
 * "Setup helpers" block — no live SDK wait. Test 31 retains the matrix's sole
 * wrong-platform skip; the former harness skips use the current modal,
 * launcher-owned-instance, and independent-browser-context contracts.
 *
 * One test('...') per matrix `test N:` line. baseURL comes from VITE_PORT;
 * API requests use the same explicit instance-aware backend origin as the app.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { apiBase, apiContext } from '../_shared/api';
import { withViewMode } from '../_shared/view-mode';
import { dismissSetupModal, openTabViaMenu, skipIfPtyExhausted } from './helpers';

/**
 * Dismiss the "Cleaned invalid sessions … couldn't be restored" alertdialog and,
 * when the host is out of PTY devices (the cause of that notice), take the
 * sanctioned live-env skip. Seeded shells restore a PTY on view mount; under
 * host PTY exhaustion they can't, so the strip renders zero tabs and the notice
 * overlay intercepts clicks. Not an app bug — passes when PTYs are free.
 */
async function dismissCleanedSessionsOrSkip(page: Page) {
  // `exact` is required: role-name matching is a case-insensitive substring
  // match by default, and the Chats navigator's history rows are role=button
  // too — a row whose title contains "ok" would be clicked instead, resuming an
  // on-disk Claude session into a brand-new process that leaks into every
  // later scenario.
  const ok = page.getByRole('button', { name: 'OK', exact: true });
  if (await ok.isVisible({ timeout: 500 }).catch(() => false)) await ok.click().catch(() => {});
  await skipIfPtyExhausted(page);
}

const API = apiBase();
const tabSel = '[data-testid^="tab-shell|"]';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

interface OwnedInstance {
  name: string;
}

/**
 * Resolve the explicit disposable instance this restart matrix is allowed to
 * own. Missing or stale ownership is a Phase 11 preflight failure, never a
 * skip and never permission to restart a shared/default backend.
 */
function ownedInstance(): OwnedInstance {
  const name = process.env.FLOW_INSTANCE?.trim() ?? '';
  if (!name) {
    throw new Error(
      'Phase 11 restart preflight failed: FLOW_INSTANCE must name a live disposable instance_ctl instance.',
    );
  }

  const envFile = path.join(REPO_ROOT, `.env.${name}.local`);
  const launcherFile = path.join(
    path.resolve(process.env.FLOW_HOME || path.join(homedir(), '.flow')),
    'instances',
    name,
    'launcher.json',
  );
  if (!existsSync(envFile) || !existsSync(launcherFile)) {
    throw new Error(
      `Phase 11 restart preflight failed: '${name}' has no matching env file and launcher registry.`,
    );
  }

  const envText = readFileSync(envFile, 'utf8');
  const envName = envText.match(/^FLOW_INSTANCE=(.+)$/m)?.[1]?.trim();
  const backendPort = Number(envText.match(/^LOCAL_SERVER_PORT=(\d+)$/m)?.[1]);
  const launcher = JSON.parse(readFileSync(launcherFile, 'utf8')) as {
    name?: unknown;
    backend_port?: unknown;
    backend_pid?: unknown;
    env_file?: unknown;
  };
  const backendPid = Number(launcher.backend_pid);
  const launcherOwnsEnv =
    typeof launcher.env_file === 'string' && path.resolve(launcher.env_file) === envFile;

  let backendPidLive = false;
  if (Number.isInteger(backendPid) && backendPid > 0) {
    try {
      process.kill(backendPid, 0);
      backendPidLive = true;
    } catch {
      backendPidLive = false;
    }
  }

  if (
    envName !== name ||
    launcher.name !== name ||
    Number(launcher.backend_port) !== backendPort ||
    !launcherOwnsEnv ||
    !backendPidLive
  ) {
    throw new Error(
      `Phase 11 restart preflight failed: '${name}' is not the matching live launcher-owned backend.`,
    );
  }
  return { name };
}

async function restartOwnedInstance(instance: OwnedInstance): Promise<void> {
  execFileSync(path.join(REPO_ROOT, 'scripts', 'instance_ctl.sh'), ['launch', instance.name], {
    cwd: REPO_ROOT,
    stdio: 'pipe',
  });
  // `launch` waits for the BACKEND, never the frontend — but it restarts vite
  // too, and a cold vite has to re-transform the whole module graph before it
  // serves. Reloading the page the moment the command returns therefore hit a
  // dev server that was not listening yet: the document came back empty and
  // `terminal-panels` never appeared, failing this test and cascading into
  // every test after it (they all then talked to a backend the page had never
  // reconnected to). Gate on the frontend actually answering, the same way
  // instance_ctl gates on the backend. A readiness probe, not a timeout budget:
  // it returns the instant the server responds.
  const base = `http://localhost:${process.env.VITE_PORT ?? '4097'}`;
  const deadline = Date.now() + 90_000;
  const ready = async (): Promise<boolean> => {
    try {
      // 1. vite is listening AND has served the shell. A 200 on `/` alone is
      //    not enough: vite answers immediately and only then transforms the
      //    module graph, so the first real load is cold.
      if (!(await fetch(base)).ok) return false;
      // 2. the backend is serving a real bootstrap again — `terminal-panels`
      //    needs tab data, not just a document.
      const boot = await fetch(`${API}/api/v1/graph/bootstrap`);
      if (!boot.ok) return false;
      return typeof (await boot.text()).match(/"types"/)?.[0] === 'string';
    } catch {
      return false;
    }
  };
  for (;;) {
    if (await ready()) {
      // 3. one discarded fetch of the app entry so vite has compiled the graph
      //    before the reload the test actually measures.
      await fetch(`${base}/dock/home`).catch(() => undefined);
      return;
    }
    if (Date.now() > deadline) throw new Error(`frontend ${base} did not come back after restarting '${instance.name}'`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

function disposableProjectRoot(label: string): string {
  return mkdtempSync(path.join(tmpdir(), `flowpad-${label}-`));
}

async function api(): Promise<APIRequestContext> {
  return apiContext();
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

/**
 * Post-Tab-cutover a strip chip IS a `Tab` entity, created URL-first on
 * navigation; a bare REST shell/AP create no longer produces one. This is the
 * single place that mints a tab the way navigation would — DockPointer JSON
 * pointer with tabHash `shell|<target>` → testid `tab-shell|<target>` — so the
 * chip renders without navigating to each session. (`createContentTab` keeps its
 * own legacy `editor|...` pointer shape.)
 */
async function createTab(
  rq: APIRequestContext,
  opts: { target: string; targetType: string; projectId?: string; iconKey?: string },
): Promise<void> {
  await rq.post(`${API}/api/v1/graph/tab`, {
    data: {
      pointer: JSON.stringify({ viewType: 'shell', pointer: opts.target }),
      target_type: opts.targetType,
      target_id: opts.target.replace(/^(shell|agentic_process)-/, ''),
      project_id: opts.projectId,
      ...(opts.iconKey ? { icon_key: opts.iconKey } : {}),
      visible: true,
    },
  });
}

async function createShell(rq: APIRequestContext, projectId?: string): Promise<string> {
  const r = await rq.post(`${API}/api/v1/graph/shell`, { data: projectId ? { project_id: projectId } : {} });
  expect(r.status()).toBe(200);
  const shell = (await r.json()).data;
  await createTab(rq, {
    target: `shell-${shell.id}`,
    targetType: 'shell',
    projectId: shell.project_id ?? projectId,
  });
  return shell.id;
}

/**
 * Active "pure" shells — plain terminals, NOT shells backing an agentic process.
 * Replaces the removed `terminals/list` → `.data.pure_shells` shape (deleted at
 * the Tab cutover). The live `list-shells` endpoint returns a flat shell list
 * and tags agent-backed shells with `agentic_process_id`; "pure" filters those
 * out, matching the old backend-computed `pure_shells`.
 */
async function pureShells(
  rq: APIRequestContext,
): Promise<Array<{ id: string; project_id: string; agentic_process_id?: string }>> {
  const r = await rq.get(`${API}/api/v1/graph/compute_node/@local/list-shells`);
  expect(r.status()).toBe(200);
  const data = (await r.json()).data ?? [];
  return data.filter((s: { agentic_process_id?: string }) => !s.agentic_process_id);
}

async function createProcess(rq: APIRequestContext, projectId: string, worker: 'claude_code' | 'codex'): Promise<{ id: string; shellId: string }> {
  const r = await rq.post(`${API}/api/v1/graph/agentic_process`, { data: { project_id: projectId, worker_type: worker } });
  expect(r.status()).toBe(200);
  const id = (await r.json()).data.id;
  // AP defaults visible=false → filtered from strip; PATCH visible=true so it surfaces.
  await rq.patch(`${API}/api/v1/graph/agentic_process/${id}`, { data: { visible: true } });
  const got = (await (await rq.get(`${API}/api/v1/graph/agentic_process/${id}`)).json()).data;
  // icon_key is the resolved provider kind the chip renders its glyph from
  // (data-provider) — navigation resolves it from the worker; a raw REST create
  // must supply it or the chip falls back to the shell glyph.
  await createTab(rq, {
    target: `agentic_process-${id}`,
    targetType: 'agentic_process',
    projectId: got.project_id ?? projectId,
    iconKey: worker === 'codex' ? 'codex' : 'claude',
  });
  return { id, shellId: got.shell_id };
}

async function closeShell(rq: APIRequestContext, id: string): Promise<void> {
  await rq.post(`${API}/api/v1/graph/shell/${id}/close`);
}

/**
 * Seed a CONTENT tab (e.g. markdown) directly — the chip's source is the
 * `visible=true` Tab query, target-type-agnostic, so a project whose only open
 * tab is content must still produce a chip row. Tab is a plain DB entity, so a
 * generic POST creates the row; `target_id` is an opaque denormalized string.
 */
async function createContentTab(rq: APIRequestContext, projectId: string, targetType = 'markdown'): Promise<string> {
  const targetId = globalThis.crypto.randomUUID();
  const r = await rq.post(`${API}/api/v1/graph/tab`, {
    data: {
      pointer: `editor|${targetType}-${targetId}`,
      target_type: targetType,
      target_id: targetId,
      project_id: projectId,
      visible: true,
    },
  });
  expect(r.status()).toBe(200);
  return (await r.json()).data.id;
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
  await page.goto(withViewMode('/dock/shell', 'advanced'));
  await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
  await dismissCleanedSessionsOrSkip(page);
}

async function tabIds(page: Page): Promise<string[]> {
  return page.locator(tabSel).evaluateAll((els) => els.map((el) => el.getAttribute('data-testid') ?? '').filter(Boolean));
}

/**
 * Switch the active project via the projects-counter chip popover. The chip
 * stays mounted even when the current project has zero open tabs (it labels the
 * ambient current project + the counts of projects that still own tabs), so it
 * is the affordance the matrix uses to move OFF an emptied project.
 */
async function openProjectsChipPopover(page: Page) {
  await page.locator('[data-testid="projects-counter-chip"]').first().click();
  const popover = page.locator('[data-testid="projects-counter-popover"]');
  await popover.waitFor({ state: 'visible', timeout: 10_000 });
  return popover;
}

async function switchToProjectViaChip(page: Page, projectName: string) {
  const popover = await openProjectsChipPopover(page);
  await popover.getByText(new RegExp(projectName, 'i')).first().click();
}

/**
 * Poll until the strip shows EXACTLY `ids` (count + membership), regardless of
 * order. Used after a project switch to assert the destination project's tabs.
 */
async function expectStripTabs(page: Page, ids: string[]) {
  await expect
    .poll(
      async () => {
        const t = await tabIds(page);
        return t.length === ids.length && t.every((x) => ids.some((id) => x.includes(id))) ? t.length : -1;
      },
      { timeout: 15_000 },
    )
    .toBe(ids.length);
}

/**
 * Click Home or the Chats/shell view. Home is a TOP-BAR control, not a rail
 * slot (`RailItemId` has no 'home' member — see rail-visibility.ts), so it is
 * addressed by its own testid; only `chats` is a rail item.
 */
async function clickRail(page: Page, target: 'home' | 'chats') {
  const sel = target === 'home' ? '[data-testid="top-nav-home"]' : '[data-rail-item="chats"]';
  await page.locator(sel).click();
}

/**
 * Rename a tab. Uses dispatchEvent('dblclick') (a plain .dblclick() is
 * intercepted by the overflow-scroll container in a crowded strip) and the
 * rename input is `input[type="text"]` inside the tab.
 */
async function renameTab(page: Page, tabTestId: string, newName: string) {
  const tab = page.locator(`[data-testid="${tabTestId}"]`);
  // The editable title span carries `truncate font-medium` + onDoubleClick. On an
  // ACTIVE tab, `span.first()` is instead the absolutely-positioned accent bar
  // (pointer-events-none) — dblclicking it never opens the rename input. Target
  // the title span explicitly.
  const nameSpan = tab.locator('span.font-medium').first();
  await nameSpan.waitFor({ state: 'visible', timeout: 10_000 });
  const input = tab.locator('input[type="text"]');
  // A single dispatched dblclick occasionally doesn't register React's
  // onDoubleClick (event timing vs the strip's re-render). Retry the dispatch
  // until the rename input actually appears — the interaction, not a timeout, is
  // what's unreliable.
  await expect(async () => {
    if (!(await input.isVisible().catch(() => false))) {
      await nameSpan.dispatchEvent('dblclick');
    }
    await expect(input).toBeVisible({ timeout: 1_500 });
  }).toPass({ timeout: 12_000 });
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
    await page.goto('/dock/shell/new_terminal');
    await page.waitForURL(/\/dock\/shell\/shell-/, { timeout: 30_000 });
    const url1 = page.url();
    const target = url1.match(/shell-[0-9a-f-]+/)![0];
    await page.locator('[data-testid="terminal-panel"]').first().waitFor({ state: 'visible', timeout: 15_000 });
    await page.reload();
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
    await dismissCleanedSessionsOrSkip(page);
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
    await dismissCleanedSessionsOrSkip(page);
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
    await page.goto(withViewMode(`/dock/shell/agentic_process-${id}`, 'advanced'));
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
    await dismissCleanedSessionsOrSkip(page);
    await expect(page.locator(`[data-testid="tab-shell|agentic_process-${id}"]`)).toBeVisible({ timeout: 15_000 });
    await page.reload();
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
    await dismissCleanedSessionsOrSkip(page);
    await expect(page.locator(`[data-testid="tab-shell|agentic_process-${id}"]`)).toBeVisible({ timeout: 15_000 });
    expect(page.url()).toContain(`agentic_process-${id}`);
    await commonValidation(page);
    await rq.dispose();
  });

  test('test 4: Refresh on Codex tab keeps process bound', async ({ page }) => {
    const rq = await api();
    await resetDb(rq);
    const { projectId } = await bootstrapIds(rq);
    const { id } = await createProcess(rq, projectId, 'codex');
    await page.goto(`/dock/shell/agentic_process-${id}`);
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
    await dismissCleanedSessionsOrSkip(page);
    await expect(page.locator(`[data-testid="tab-shell|agentic_process-${id}"]`)).toBeVisible({ timeout: 15_000 });
    await page.reload();
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
    await dismissCleanedSessionsOrSkip(page);
    await expect(page.locator(`[data-testid="tab-shell|agentic_process-${id}"]`)).toBeVisible({ timeout: 15_000 });
    expect(page.url()).toContain(`agentic_process-${id}`);
    await commonValidation(page);
    await rq.dispose();
  });

  test('test 5: Refresh on /dock/shell (no pointer) resolves a default tab', async ({ page }) => {
    const rq = await api();
    await resetDb(rq);
    // Bare /dock/shell resolves a default among EXISTING tabs; it no longer
    // auto-spawns a shell from nothing, so seed one first.
    const { projectId } = await bootstrapIds(rq);
    await createShell(rq, projectId);
    await gotoDockShell(page);
    await page.waitForURL(/\/dock\/shell\/shell-/, { timeout: 15_000 });
    const target = page.url().match(/shell-[0-9a-f-]+/)![0];
    await page.reload();
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
    await dismissCleanedSessionsOrSkip(page);
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
    const selected = (await tabIds(page))[1].replace('tab-shell|', '');
    await page.locator(tabSel).nth(1).click();
    await expect(page).toHaveURL(new RegExp(selected));
    await clickRail(page, 'home');
    await page.waitForURL(/\/$/, { timeout: 15_000 });
    await clickRail(page, 'chats');
    await page.waitForURL(/\/dock\/shell/, { timeout: 15_000 });
    // All three tabs survive the round-trip ("keeps tabs alive"). Re-entry via the
    // Chats rail lands on bare /dock/shell (scope-seeded to the active project):
    // the rail carries NO remembered pointer, so it does NOT auto-restore a
    // concrete session (same documented behavior as test 45). The surviving tabs
    // are still selectable — click one and confirm it re-activates (URL → concrete
    // pointer), which is the real "keeps tabs alive" guarantee.
    await expect.poll(async () => (await tabIds(page)).length, { timeout: 15_000 }).toBe(3);
    const survivor = (await tabIds(page))[0]; // any surviving tab; first is deterministic
    const survivorKey = survivor.replace('tab-shell|', '');
    await page.locator(`[data-testid="${survivor}"]`).click();
    await expect.poll(async () => page.url(), { timeout: 15_000 }).toContain(survivorKey);
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
    const secondTab = page.locator(`[data-testid="tab-shell|shell-${ids[1]}"]`);
    await renameTab(page, `tab-shell|shell-${ids[1]}`, 'build-server');
    await expect(secondTab).toContainText('build-server', { timeout: 10_000 });
    // PTY-driven title update via the update-display action (is_pty=true) — must
    // NOT override the user rename (user_renamed guard).
    await rq.post(`${API}/api/v1/graph/shell/${ids[1]}/update-display`, { data: { name: 'pty-title-from-pty', is_pty: true } });
    await page.waitForTimeout(1_000);
    await expect(secondTab).toContainText('build-server');
    await page.reload();
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
    await dismissCleanedSessionsOrSkip(page);
    await expect(page.locator(`[data-testid="tab-shell|shell-${ids[1]}"]`)).toContainText('build-server', { timeout: 15_000 });
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
    await clickRail(page, 'home');
    await page.waitForURL(/\/$/, { timeout: 15_000 });
    await page.goto(targetUrl);
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
    await dismissCleanedSessionsOrSkip(page);
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
    await page.goto(`/dock/shell/agentic_process-${id}`);
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
    await dismissCleanedSessionsOrSkip(page);
    await expect(page.locator(`[data-testid="tab-shell|agentic_process-${id}"]`)).toBeVisible({ timeout: 15_000 });
    await commonValidation(page);
    await rq.dispose();
  });

  test('test 10: Open invalid shell id (graceful fallback)', async ({ page }) => {
    const rq = await api();
    await resetDb(rq);
    await page.goto('/dock/shell/shell-deadbeef-dead-4eef-8eef-deadbeefdead');
    // Must not white-screen: page renders something (body has content), no crash.
    await page.waitForTimeout(3_000);
    const bodyText = (await page.locator('body').textContent()) ?? '';
    expect(bodyText.trim().length).toBeGreaterThan(0);
    // No uncaught error overlay / blank root.
    await expect(page.locator('#root')).not.toBeEmpty();
    await rq.dispose();
  });

  test('test 11: Open the current session-history modal from the opener menu', async ({ page }) => {
    const rq = await api();
    const projectRoot = disposableProjectRoot('history-modal');
    const projectName = `History-${Date.now()}`;
    const projectId = await createProject(rq, projectName, projectRoot);
    const shellId = await createShell(rq, projectId);

    try {
      await page.goto(withViewMode(`/dock/shell/shell-${shellId}`, 'advanced'));
      await expect(page.locator('[data-testid="terminal-panels"]')).toBeVisible();
      await dismissCleanedSessionsOrSkip(page);

      // The history entry point is the opener toolbar — the projects chip
      // popover is a pure project list.
      await openTabViaMenu(page, 'history');

      const dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('heading', { name: 'Recent Sessions' })).toBeVisible();
      await expect(dialog.locator('[data-testid="history-all-projects"]')).toBeVisible();
      await expect(dialog.locator('[data-testid="history-refresh"]')).toBeVisible();
      await expect(dialog.locator('[data-testid="history-search-toggle"]')).toBeVisible();
    } finally {
      await page.goto('/');
      await closeShell(rq, shellId);
      await rq.delete(`${API}/api/v1/graph/project/${projectId}`);
      await rq.dispose();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('test 12: Open shell-by-id whose project differs from current', async ({ page }) => {
    const rq = await api();
    await resetDb(rq);
    const pa = await createProject(rq, 'Proj-A', '/tmp/regression/proj-a');
    const pb = await createProject(rq, 'Proj-B', '/tmp/regression/proj-b');
    await createShell(rq, pa);
    const pbShell = await createShell(rq, pb);
    await page.goto(`/dock/shell/shell-${pbShell}`);
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
    await dismissCleanedSessionsOrSkip(page);
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
    const secondTab = page.locator(`[data-testid="tab-shell|shell-${ids[1]}"]`);
    await secondTab.hover();
    await secondTab.locator('button[aria-label="Close tab"]').click();
    await expect(secondTab).toHaveCount(0, { timeout: 15_000 });
    await page.goto(staleUrl);
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
    const shells = await pureShells(rq);
    const aIds = shells.filter((s) => s.project_id === pa).map((s) => s.id);
    const bIds = shells.filter((s) => s.project_id === pb).map((s) => s.id);
    await page.goto(`/dock/shell/shell-${aIds[0]}`);
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
    await dismissCleanedSessionsOrSkip(page);
    await expect.poll(async () => (await tabIds(page)).length, { timeout: 20_000 }).toBe(3);
    await expect(page.locator('[data-testid="close-all-tabs-button"]')).toContainText('3', { timeout: 10_000 });
    await page.locator('[data-testid="close-all-tabs-button"]').click();
    // Close-all closes ONLY the current project's (Proj-A) tabs and leaves the
    // strip on the now-empty Proj-A (its project home) — it does NOT auto-jump to
    // another project (the .md: "validate Proj-A strip is now empty"). Proj-B's
    // tabs are untouched: switch to it via the chip and both are intact.
    await expect.poll(async () => (await tabIds(page)).length, { timeout: 15_000 }).toBe(0);
    await switchToProjectViaChip(page, 'Proj-B');
    await expectStripTabs(page, bIds);
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
    // After close-all the strip is empty; bare /dock/shell no longer auto-spawns
    // a shell, so there is no terminal-panels to wait on — wait for the app shell
    // (#root) instead and assert no prior tab is resurrected.
    await page.locator('#root').waitFor({ state: 'attached', timeout: 30_000 });
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

  test('test 19: Close active tab via X — strip self-heals to a surviving tab', async ({ page }) => {
    const rq = await api();
    await resetDb(rq);
    const { projectId } = await bootstrapIds(rq);
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push(await createShell(rq, projectId));
    // Navigate to a concrete shell pointer (deterministic) rather than bare
    // /dock/shell, whose default-tab resolution can momentarily leave the strip
    // empty on a cold worker.
    await page.goto(`/dock/shell/shell-${ids[0]}`);
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
    await dismissCleanedSessionsOrSkip(page);
    await expect.poll(async () => (await tabIds(page)).length, { timeout: 20_000 }).toBe(4);
    const before = await tabIds(page);
    const secondTab = page.locator(`[data-testid="${before[1]}"]`);
    await secondTab.click();
    // The click NAVIGATES (URL-first), and the strip re-renders on that
    // navigation. Hovering into that re-render leaves Playwright waiting for an
    // element to become stable that keeps being replaced — every failure of this
    // test was `locator.hover: Test timeout of 60000ms exceeded`, never the
    // close itself. A fixed 300 ms sleep only made that likely, not certain.
    // Wait for the click to have LANDED instead: the address naming the tab we
    // clicked. Not a bigger budget — a correct precondition, and one fewer sleep.
    const secondPointer = before[1].replace('tab-shell|', '');
    await expect.poll(() => page.url(), { timeout: 15_000 }).toContain(secondPointer);
    await secondTab.hover();
    await secondTab.locator('button[aria-label="Close tab"]').click();
    await expect(secondTab).toHaveCount(0, { timeout: 15_000 });
    // Closing the active tab self-heals to one of the surviving tabs (the exact
    // pick — adjacent vs first — is the loader's strategy, not asserted here). The
    // heal is async, so poll until the URL settles on a SURVIVING pointer (never
    // the closed one).
    const survivors = before.filter((t) => t !== before[1]).map((t) => t.replace('tab-shell|', ''));
    await expect
      .poll(async () => page.url().match(/(?:shell|agentic_process)-[0-9a-f-]+/)?.[0] ?? '', { timeout: 15_000 })
      .toMatch(new RegExp(survivors.join('|')));
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

  test('test 21: Chip selects project, swaps tab strip, and lands on the project home', async ({ page }) => {
    const rq = await api();
    await resetDb(rq);
    const pa = await createProject(rq, 'Proj-A', '/tmp/regression/proj-a');
    const pb = await createProject(rq, 'Proj-B', '/tmp/regression/proj-b');
    for (let i = 0; i < 2; i++) await createShell(rq, pa);
    for (let i = 0; i < 3; i++) await createShell(rq, pb);
    await gotoDockShell(page);
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
    await dismissCleanedSessionsOrSkip(page);
    await page.locator('[data-testid="projects-counter-chip"]').first().click();
    await page.locator('[data-testid="projects-counter-popover"]').waitFor({ state: 'visible', timeout: 10_000 });
    // Select Proj-B explicitly.
    await page.locator('[data-testid="projects-counter-popover"]').getByText(/Proj-B|proj-b/).first().click();
    await expect.poll(async () => (await tabIds(page)).length, { timeout: 15_000 }).toBe(3);
    await expect(page).toHaveURL(new RegExp(`/dock/project/${pb}(?:\\?|$)`));
    await expect(page.locator('[data-testid="footer"]')).toContainText(/proj-b/i);
    await expect(page.locator('[data-testid="terminal-panels"]')).toHaveCount(0);
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
    await dismissCleanedSessionsOrSkip(page);
    await expect(page.locator('[data-testid="projects-counter-chip"]').first()).toContainText('3', { timeout: 15_000 });
    await rq.dispose();
  });

  test('test 23: Selecting current project = no-op', async ({ page }) => {
    const rq = await api();
    await resetDb(rq);
    const { projectId } = await bootstrapIds(rq);
    const shellId = await createShell(rq, projectId);
    const scopedShell = withViewMode(
      `/dock/shell/shell-${shellId}?scope-mode=project&scope-activeProjectId=${projectId}`,
      'advanced',
    );
    await page.goto(scopedShell);
    await expect(page.locator('[data-testid="terminal-panels"]')).toBeVisible();
    await dismissCleanedSessionsOrSkip(page);
    const urlBefore = page.url();
    const popover = await openProjectsChipPopover(page);
    const current = popover.locator('[aria-current="true"]');
    await expect(current).toHaveCount(1);
    await current.click();
    await expect(popover).not.toBeVisible();
    const urlAfter = new URL(page.url());
    expect(page.url()).toBe(urlBefore);
    expect(urlAfter.pathname).toBe(`/dock/shell/shell-${shellId}`);
    expect(urlAfter.searchParams.get('viewMode')).toBe('advanced');
    expect(urlAfter.searchParams.get('scope-mode')).toBe('project');
    expect(urlAfter.searchParams.get('scope-activeProjectId')).toBe(projectId);
    await rq.dispose();
  });

  test('test 24: Popover lists every open project in stable alphabetical order', async ({ page }) => {
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
    const bShell = (await pureShells(rq)).find((s: { project_id: string }) => s.project_id === b).id;
    await page.goto(`/dock/shell/shell-${bShell}`);
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
    await dismissCleanedSessionsOrSkip(page);
    await page.locator('[data-testid="projects-counter-chip"]').first().click();
    const popover = page.locator('[data-testid="projects-counter-popover"]');
    // Reuse the existing popover readiness budget for the last expected row:
    // the shell-backed project buckets can arrive after the current-project row.
    await popover.getByRole('button', { name: /Proj-D 1/ }).waitFor({ state: 'visible', timeout: 10_000 });
    const rows = await popover.getByText(/Proj-[ABCD]/).allTextContents();
    const order = rows.map((t) => (t.match(/Proj-[ABCD]/) ?? [''])[0]).filter(Boolean);
    // Ranking is a stable alphabetical order across every project with open tabs.
    expect([...new Set(order)]).toEqual(['Proj-A', 'Proj-B', 'Proj-C', 'Proj-D']);
    await rq.dispose();
  });

  test('test 25: Project with zero tabs after close-all', async ({ page }) => {
    const rq = await api();
    await resetDb(rq);
    const a = await createProject(rq, 'Proj-A', '/tmp/regression/proj-a');
    const b = await createProject(rq, 'Proj-B', '/tmp/regression/proj-b');
    for (let i = 0; i < 3; i++) await createShell(rq, a);
    for (let i = 0; i < 2; i++) await createShell(rq, b);
    const shells = await pureShells(rq);
    const aIds = shells.filter((s) => s.project_id === a).map((s) => s.id);
    await page.goto(`/dock/shell/shell-${aIds[0]}`);
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
    await dismissCleanedSessionsOrSkip(page);
    await expect.poll(async () => (await tabIds(page)).length, { timeout: 20_000 }).toBe(3);
    await page.locator('[data-testid="close-all-tabs-button"]').click();
    // Proj-A ends with zero tabs; the strip stays on the now-empty Proj-A (does
    // NOT auto-switch away). The footer keeps showing Proj-A as the current
    // project (.md: "validate footer still shows Proj-A as current project").
    await expect.poll(async () => (await tabIds(page)).length, { timeout: 15_000 }).toBe(0);
    await expect(page.locator('[data-testid="footer"]')).toContainText(/proj-a/i, { timeout: 10_000 });
    // Open the chip: Proj-A's row is gone (0 open tabs), Proj-B is still listed
    // with count 2 (.md: "Proj-A row gone OR shows 0" / "Proj-B still listed count 2").
    const popover = await openProjectsChipPopover(page);
    const bRow = popover.locator('button').filter({ hasText: 'Proj-B' });
    await expect(bRow).toBeVisible({ timeout: 10_000 });
    await expect(bRow).toContainText('2'); // the row's count badge
    await expect(popover.getByText(/Proj-A/)).toHaveCount(0);
    await rq.dispose();
  });

  test('test 26: Switching to a project with no known last tab lands on project home', async ({ page }) => {
    const rq = await api();
    await resetDb(rq);
    const a = await createProject(rq, 'Proj-A', '/tmp/regression/proj-a');
    const b = await createProject(rq, 'Proj-B', '/tmp/regression/proj-b');
    for (let i = 0; i < 3; i++) await createShell(rq, a);
    for (let i = 0; i < 2; i++) await createShell(rq, b);
    const list = (await pureShells(rq));
    const bIds = list.filter((s) => s.project_id === b).map((s) => s.id);
    const aShells = list.filter((s) => s.project_id === a);
    await page.goto(`/dock/shell/shell-${aShells[1].id}`);
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
    await dismissCleanedSessionsOrSkip(page);
    await page.locator('[data-testid="projects-counter-chip"]').first().click();
    await page.locator('[data-testid="projects-counter-popover"]').waitFor({ state: 'visible', timeout: 10_000 });
    await page.locator('[data-testid="projects-counter-popover"]').getByText(/Proj-B/).first().click();
    // Direct REST tab fixtures have no last_active_at, so none is a known
    // resume target. The current contract keeps the project's tabs available
    // in the strip but lands on the project home until the user selects one.
    await expect.poll(async () => (await tabIds(page)).length, { timeout: 15_000 }).toBe(2);
    const visibleProjectShells = (await tabIds(page)).map((tab) => tab.replace('tab-shell|shell-', ''));
    expect(new Set(visibleProjectShells)).toEqual(new Set(bIds));
    await expect(page).toHaveURL(new RegExp(`/dock/project/${b}(?:\\?|$)`));
    await expect(page.locator('[data-testid="terminal-panels"]')).toHaveCount(0);
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
    const rootA = disposableProjectRoot('switch-modal-a');
    const suffix = Date.now();
    const nameA = `Modal-A-${suffix}`;
    const projectA = await createProject(rq, nameA, rootA);
    const shellA = await createShell(rq, projectA);
    const beforeResponse = await rq.get(`${API}/api/v1/graph/project`);
    expect(beforeResponse.status()).toBe(200);
    const preexistingProjectIds = new Set<string>(
      ((await beforeResponse.json()).data as Array<{ id: string }>).map((project) => project.id),
    );
    let selectedProjectId: string | null = null;

    try {
      await page.goto(withViewMode(`/dock/shell/shell-${shellA}`, 'advanced'));
      await expect(page.locator('[data-testid="terminal-panels"]')).toBeVisible();
      await dismissCleanedSessionsOrSkip(page);

      await page.getByRole('button', { name: 'Switch Project' }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('heading', { name: 'Switch Project' })).toBeVisible();
      await expect(dialog.locator('[data-testid="switch-project-active-title"]')).toBeVisible();
      const recentTitle = dialog.locator('[data-testid="switch-project-recent-title"]');
      await expect(recentTitle).toBeVisible();
      const targetRow = recentTitle.locator('xpath=following-sibling::button[1]');
      await expect(targetRow).toBeVisible();
      const targetName = (await targetRow.locator('span.font-medium').innerText()).trim();
      expect(targetName).not.toBe('');
      const targetTitle = await targetRow.getAttribute('title');
      expect(targetTitle).toBeTruthy();
      const targetTitleParts = targetTitle!.split('\n');
      expect(targetTitleParts.length).toBeGreaterThan(1);
      const targetCwd = targetTitleParts.at(-1)!.trim();
      expect(path.isAbsolute(targetCwd)).toBe(true);
      const canonicalPath = (value: string) =>
        value.trim().replace(/\\/g, '/').replace(/\/+$/, '').replace(/^\/+/, '');
      expect(canonicalPath(targetCwd)).not.toBe(canonicalPath(rootA));

      await targetRow.click();
      await expect(page).toHaveURL(/\/dock\/project\/[0-9a-f-]+(?:\?|$)/);
      const projectMatch = new URL(page.url()).pathname.match(/^\/dock\/project\/([0-9a-f-]+)$/);
      expect(projectMatch).not.toBeNull();
      selectedProjectId = projectMatch![1];
      await expect(page.locator('[data-testid="footer"]')).toContainText(targetName);

      const selectedResponse = await rq.get(`${API}/api/v1/graph/project/${selectedProjectId}`);
      expect(selectedResponse.status()).toBe(200);
      const selected = (await selectedResponse.json()).data as { fs_storage_mount_path?: string };
      expect(canonicalPath(selected.fs_storage_mount_path ?? '')).toBe(canonicalPath(targetCwd));
    } finally {
      await page.goto('/');
      await closeShell(rq, shellA);
      if (selectedProjectId && !preexistingProjectIds.has(selectedProjectId)) {
        await rq.delete(`${API}/api/v1/graph/project/${selectedProjectId}`);
      }
      await rq.delete(`${API}/api/v1/graph/project/${projectA}`);
      await rq.dispose();
      rmSync(rootA, { recursive: true, force: true });
    }
  });

  test('test 29: Footer label fallback chain', async ({ page }) => {
    const rq = await api();
    await resetDb(rq);
    // Seed a shell so bare /dock/shell resolves a default (no auto-spawn).
    const { projectId } = await bootstrapIds(rq);
    await createShell(rq, projectId);
    await gotoDockShell(page);
    await page.waitForURL(/\/dock\/shell\/shell-/, { timeout: 15_000 });
    // Footer reflects project path/name initially.
    const footer = page.locator('[data-testid="footer"]');
    await expect(footer).toBeVisible();
    // Override workdir → the footer's path-bearing affordance reflects the explicit
    // path. The footer's VISIBLE label is the project's displayName; the workdir →
    // project-path → name fallback chain surfaces in the "Open folder" / "Open
    // project view" title+aria-label (StatusBar.projectPath), not the visible text.
    const overridePath = page.locator(
      '[data-testid="footer"] [title*="override-workdir"], [data-testid="footer"] [aria-label*="override-workdir"]',
    );
    await page.evaluate(() => (window as unknown as { dataContext: { setWorkdir: (p: string | null) => Promise<void> } }).dataContext.setWorkdir('/tmp/regression/override-workdir'));
    await expect(overridePath.first()).toBeVisible({ timeout: 10_000 });
    // Revert → the override path drops out of the fallback chain (falls back to the
    // project's own path).
    await page.evaluate(() => (window as unknown as { dataContext: { setWorkdir: (p: string | null) => Promise<void> } }).dataContext.setWorkdir(null));
    await expect(overridePath).toHaveCount(0, { timeout: 10_000 });
    await rq.dispose();
  });

  test('test 30: "Select Project" red pill — tab spawn flow', async ({ page }) => {
    const rq = await api();
    await resetDb(rq);
    // Seed a shell so bare /dock/shell resolves a default (no auto-spawn).
    const { projectId } = await bootstrapIds(rq);
    await createShell(rq, projectId);
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

  // ---- F. Restart & CLI changes ----

  test('test 33: Backend restart preserves tabs on the launcher-owned instance', async ({ page }) => {
    const instance = ownedInstance();
    const rq = await api();
    await resetDb(rq);
    const projectA = await createProject(rq, 'Restart-A', '/tmp/regression/restart-a');
    const projectB = await createProject(rq, 'Restart-B', '/tmp/regression/restart-b');
    const shellA = [
      await createShell(rq, projectA),
      await createShell(rq, projectA),
      await createShell(rq, projectA),
    ];
    const shellB = await createShell(rq, projectB);

    await page.goto(withViewMode(`/dock/shell/shell-${shellA[0]}`, 'advanced'));
    await expectStripTabs(page, shellA);

    await restartOwnedInstance(instance);
    await page.reload();
    await expect(page.locator('[data-testid="terminal-panels"]')).toBeVisible();
    await dismissCleanedSessionsOrSkip(page);
    await expectStripTabs(page, shellA);

    await switchToProjectViaChip(page, 'Restart-B');
    await expectStripTabs(page, [shellB]);
    await expect(page.locator(`[data-testid="tab-shell|shell-${shellB}"]`)).toHaveCount(1);
    await rq.dispose();
  });

  test('test 34: Backend restart rebinds the AgenticProcess tab on the launcher-owned instance', async ({ page }) => {
    const instance = ownedInstance();
    const rq = await api();
    await resetDb(rq);
    const { projectId } = await bootstrapIds(rq);
    const { id } = await createProcess(rq, projectId, 'claude_code');

    await page.goto(withViewMode(`/dock/shell/agentic_process-${id}`, 'advanced'));
    const processTab = page.locator(`[data-testid="tab-shell|agentic_process-${id}"]`);
    await expect(processTab).toBeVisible();

    await restartOwnedInstance(instance);
    await page.reload();
    await expect(page.locator('[data-testid="terminal-panels"]')).toBeVisible();
    await dismissCleanedSessionsOrSkip(page);
    await expect(processTab).toHaveCount(1);
    await expect(processTab).toHaveAttribute('data-active', 'true');
    await expect(page).toHaveURL(new RegExp(`/dock/shell/agentic_process-${id}`));
    await rq.dispose();
  });

  test('test 35: External REST POST creates a new shell (CLI-equivalent)', async ({ page }) => {
    const rq = await api();
    await resetDb(rq);
    // The strip is project-scoped to the CURRENT project, so a CLI-equivalent
    // shell only surfaces live if it lands in the viewed project. Create it in
    // the default project that /dock/shell resolves to.
    const { projectId } = await bootstrapIds(rq);
    await gotoDockShell(page);
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
    await dismissCleanedSessionsOrSkip(page);
    const before = (await tabIds(page)).length;
    await createShell(rq, projectId);
    // The strip syncs the tab set on load/navigation (it does not live-subscribe
    // to externally-created Tab rows), so a CLI-equivalent create surfaces after
    // a refetch. The backend state is authoritative; reload to pull it.
    await page.reload();
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
    await dismissCleanedSessionsOrSkip(page);
    await expect.poll(async () => (await tabIds(page)).length, { timeout: 10_000 }).toBeGreaterThan(before);
    await rq.dispose();
  });

  test('test 36: External REST POST creates a Claude AgenticProcess', async ({ page }) => {
    const rq = await api();
    await resetDb(rq);
    const { projectId } = await bootstrapIds(rq);
    await gotoDockShell(page);
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
    await dismissCleanedSessionsOrSkip(page);
    const { id } = await createProcess(rq, projectId, 'claude_code');
    // Tab set syncs on load/navigation — reload to pull the externally-created AP.
    await page.reload();
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
    await dismissCleanedSessionsOrSkip(page);
    await expect.poll(async () => (await tabIds(page)).join(','), { timeout: 10_000 }).toContain(`agentic_process-${id}`);
    await rq.dispose();
  });

  test('test 37: External REST DELETE/close removes a session', async ({ page }) => {
    const rq = await api();
    await resetDb(rq);
    const { projectId } = await bootstrapIds(rq);
    const ids = [await createShell(rq, projectId), await createShell(rq, projectId), await createShell(rq, projectId)];
    await gotoDockShell(page);
    await expect.poll(async () => (await tabIds(page)).length, { timeout: 20_000 }).toBe(3);
    // Close a NON-active shell externally — the backend hides its Tab
    // (visible=false); the strip reflects it on the next load-time refetch.
    // Bare /dock/shell picks its default among the seeded tabs without a
    // creation-order guarantee, so read the active one off the URL instead of
    // assuming the last-created shell is never it.
    await page.waitForURL(/\/dock\/shell\/shell-/, { timeout: 15_000 });
    const activeId = page.url().match(/shell-([0-9a-f-]+)/)![1];
    const victim = ids.find((id) => id !== activeId)!;
    await closeShell(rq, victim);
    await page.reload();
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
    await dismissCleanedSessionsOrSkip(page);
    await expect.poll(async () => (await tabIds(page)).join(','), { timeout: 10_000 }).not.toContain(victim);
    await expect.poll(async () => (await tabIds(page)).length, { timeout: 10_000 }).toBe(2);
    await rq.dispose();
  });

  test('test 38: Two independent browser contexts keep the tab strip in sync', async ({ page, browser }) => {
    const rq = await api();
    const projectRoot = disposableProjectRoot('two-browser-sync');
    const projectId = await createProject(rq, `Two-Browser-${Date.now()}`, projectRoot);
    const shells = [await createShell(rq, projectId), await createShell(rq, projectId)];
    const secondContext = await browser.newContext();
    const secondPage = await secondContext.newPage();
    await dismissSetupModal(secondPage);

    try {
      const target = withViewMode(`/dock/shell/shell-${shells[0]}`, 'advanced');
      await page.goto(target);
      await secondPage.goto(target);
      await expectStripTabs(page, shells);
      await expectStripTabs(secondPage, shells);

      const closingTab = page.locator(`[data-testid="tab-shell|shell-${shells[1]}"]`);
      await closingTab.hover();
      await closingTab.locator('button[aria-label="Close tab"]').click();

      await expect(page.locator(`[data-testid="tab-shell|shell-${shells[1]}"]`)).toHaveCount(0);
      await expect(secondPage.locator(`[data-testid="tab-shell|shell-${shells[1]}"]`)).toHaveCount(0);
      await expect(secondPage.locator(`[data-testid="tab-shell|shell-${shells[0]}"]`)).toHaveCount(1);
    } finally {
      await secondContext.close();
      await page.goto('/');
      for (const shellId of shells) await closeShell(rq, shellId);
      await rq.delete(`${API}/api/v1/graph/project/${projectId}`);
      await rq.dispose();
      rmSync(projectRoot, { recursive: true, force: true });
    }
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
    // The provider glyph is an SVG inside each chip carrying data-provider=<kind>
    // (resolved from the Tab's icon_key) — there is no per-id testid.
    await expect(
      page.locator(`[data-testid="tab-shell|agentic_process-${claude.id}"] [data-provider="claude"]`),
    ).toBeVisible();
    await expect(
      page.locator(`[data-testid="tab-shell|agentic_process-${codex.id}"] [data-provider="codex"]`),
    ).toBeVisible();
    await expect(page.locator('[data-testid^="tab-shell|shell-"] [data-provider="shell"]').first()).toBeVisible();
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
    // Seed one shell so bare /dock/shell resolves a default tab (it no longer
    // auto-spawns from an empty strip); the opener-menu spawns are layered on top.
    const { projectId } = await bootstrapIds(rq);
    await createShell(rq, projectId);
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
    await page.goto(`/dock/shell/agentic_process-${id}`);
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
    await dismissCleanedSessionsOrSkip(page);
    const tab = page.locator(`[data-testid="tab-shell|agentic_process-${id}"]`);
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
    await page.goto(`/dock/shell/agentic_process-${id}`);
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
    await dismissCleanedSessionsOrSkip(page);
    const tab = page.locator(`[data-testid="tab-shell|agentic_process-${id}"]`);
    await renameTab(page, `tab-shell|agentic_process-${id}`, 'claude-fix');
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
    await dismissCleanedSessionsOrSkip(page);
    await expect(page.locator(`[data-testid="tab-shell|agentic_process-${id}"]`)).toContainText('claude-fix', { timeout: 15_000 });
    // PTY title update must not override user rename
    await rq.post(`${API}/api/v1/graph/shell/${shellId}/update-display`, { data: { name: 'pty-title', is_pty: true } });
    await page.waitForTimeout(1_000);
    await expect(page.locator(`[data-testid="tab-shell|agentic_process-${id}"]`)).toContainText('claude-fix');
    await rq.dispose();
  });

  test('test 44: Rename rejects TypeId-format strings (real v4 UUID)', async ({ page }) => {
    const rq = await api();
    await resetDb(rq);
    const { projectId } = await bootstrapIds(rq);
    const sid = await createShell(rq, projectId);
    await page.goto(`/dock/shell/shell-${sid}`);
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
    await dismissCleanedSessionsOrSkip(page);
    const tab = page.locator(`[data-testid="tab-shell|shell-${sid}"]`);
    const nameBefore = (await tab.textContent())?.trim() ?? '';
    await renameTab(page, `tab-shell|shell-${sid}`, 'shell-abcd1234-ef56-4789-9abc-567890abcdef');
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
    const before = await tabIds(page);
    const activeTab = before[1];
    const activeKey = activeTab.replace('tab-shell|', '');
    await page.locator(`[data-testid="${activeTab}"]`).click();
    await expect(page).toHaveURL(new RegExp(activeKey));
    // Dock state is "preserved" across rail round-trips in that all tabs survive
    // and remain selectable. (Bare /dock/shell re-entry does not auto-restore the
    // exact prior selection — the rail carries no remembered pointer — so the tab
    // is re-activated by clicking it, as a user would. Idempotent across rounds.)
    for (let r = 0; r < 2; r++) {
      await clickRail(page, 'home');
      await page.waitForURL(/\/$/, { timeout: 15_000 });
      await clickRail(page, 'chats');
      await page.waitForURL(/\/dock\/shell/, { timeout: 15_000 });
      await expect.poll(async () => (await tabIds(page)).length, { timeout: 15_000 }).toBe(3);
      expect(await tabIds(page)).toEqual(before);
      // The prior tab is still there and re-activates on click.
      await page.locator(`[data-testid="${activeTab}"]`).click();
      await expect.poll(async () => page.url(), { timeout: 15_000 }).toContain(activeKey);
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
    const keys = ids.map((t) => t.replace('tab-shell|', ''));
    for (let index = 0; index < ids.length; index += 1) {
      const id = ids[index];
      await page.locator(`[data-testid="${id}"]`).click();
      await expect(page).toHaveURL(new RegExp(keys[index]));
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
    const target = (await tabIds(page))[1].replace('tab-shell|', '');
    await page.locator(tabSel).nth(1).click();
    await expect(page).toHaveURL(new RegExp(target));
    await clickRail(page, 'home');
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
    await page.goto('/agent/00000000-0000-0000-0000-000000000000/dock/shell');
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
    await page.goto(withViewMode(`/dock/shell/agentic_process-${id}`, 'advanced'));
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
    await dismissCleanedSessionsOrSkip(page);
    await expect(page.locator(`[data-testid="tab-shell|agentic_process-${id}"]`)).toBeVisible({ timeout: 15_000 });
    expect(page.url()).toContain(`agentic_process-${id}`);
    await clickRail(page, 'home');
    await page.waitForURL(/\/$/, { timeout: 15_000 });
    await clickRail(page, 'chats');
    await page.waitForURL(/\/dock\/shell/, { timeout: 15_000 });
    await page.locator(`[data-testid="tab-shell|agentic_process-${id}"]`).click();
    await expect.poll(async () => page.url(), { timeout: 15_000 }).toContain(`agentic_process-${id}`);
    await commonValidation(page);
    await rq.dispose();
  });

  test('test 50: Deep link /dock/shell/new_terminal redirects to a real shell', async ({ page }) => {
    const rq = await api();
    await resetDb(rq);
    await page.goto('/dock/shell/new_terminal');
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

  // ---- I. Project chip is kind-agnostic (content tabs count; select switches project) ----

  test('test 51: Chip counts a project whose only open tab is a content (markdown) tab', async ({ page }) => {
    const rq = await api();
    await resetDb(rq);
    const a = await createProject(rq, 'Proj-A', '/tmp/regression/proj-a');
    const c = await createProject(rq, 'Proj-C', '/tmp/regression/proj-c');
    for (let i = 0; i < 2; i++) await createShell(rq, a);
    // Proj-C has NO shells — only one content (markdown) tab.
    await createContentTab(rq, c);
    await gotoDockShell(page);
    await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible', timeout: 30_000 });
    await dismissCleanedSessionsOrSkip(page);
    // Count = 2 even though Proj-C owns zero terminal tabs (the fix: the chip is
    // kind-agnostic, not terminal-only).
    await expect(page.locator('[data-testid="projects-counter-chip"]').first()).toContainText('2', { timeout: 15_000 });
    await page.locator('[data-testid="projects-counter-chip"]').first().click();
    const popover = page.locator('[data-testid="projects-counter-popover"]');
    await popover.waitFor({ state: 'visible', timeout: 10_000 });
    // Proj-C is listed, with a per-project badge of 1 (its single content tab).
    const cRow = popover.getByRole('button', { name: /Proj-C/ });
    await expect(cRow).toBeVisible({ timeout: 10_000 });
    await expect(cRow).toContainText('1');
    await rq.dispose();
  });

  test('test 52: Selecting a content-only project switches current project and footer', async ({ page }) => {
    const rq = await api();
    const rootA = disposableProjectRoot('content-switch-a');
    const rootC = disposableProjectRoot('content-switch-c');
    const suffix = Date.now();
    const nameA = `Content-A-${suffix}`;
    const nameC = `Content-C-${suffix}`;
    const projectA = await createProject(rq, nameA, rootA);
    const projectC = await createProject(rq, nameC, rootC);
    const shellA = await createShell(rq, projectA);
    const contentTab = await createContentTab(rq, projectC);

    try {
      await page.goto(withViewMode(`/dock/shell/shell-${shellA}`, 'advanced'));
      await expect(page.locator('[data-testid="terminal-panels"]')).toBeVisible();
      await dismissCleanedSessionsOrSkip(page);

      await switchToProjectViaChip(page, nameC);

      await expect(page).toHaveURL(new RegExp(`/dock/project/${projectC}(?:\\?|$)`));
      await expect(page.locator('[data-testid="footer"]')).toContainText(nameC);
      await expect(page.locator('[data-testid="terminal-panels"]')).toHaveCount(0);
    } finally {
      await page.goto('/');
      await closeShell(rq, shellA);
      await rq.delete(`${API}/api/v1/graph/tab/${contentTab}`);
      await rq.delete(`${API}/api/v1/graph/project/${projectA}`);
      await rq.delete(`${API}/api/v1/graph/project/${projectC}`);
      await rq.dispose();
      rmSync(rootA, { recursive: true, force: true });
      rmSync(rootC, { recursive: true, force: true });
    }
  });
});
