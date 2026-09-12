/** Live browser/backend validation with CONTROLLED native Copilot metadata.
 * No CLI or model turn runs here. The real CLI matrix lives in
 * worker_session_names.md.ts; these fixtures isolate naming authority and
 * cross-browser notification behavior from provider authentication.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import { apiContext } from '../_shared/api';
import { withViewMode } from '../_shared/view-mode';

const AP = '/api/v1/graph/agentic_process';
const workspaceRoot = process.env.NAMING_WORKSPACE_ROOT;
const nativeRoot = process.env.COPILOT_HOME;
const enabled = process.env.NAMING_NATIVE_FIXTURES === 'true';
const fallback = 'Controlled first prompt fallback';
const harnessTitle = 'Verified native fixture title';
const laterTitle = 'Later native fixture title must lose';

const panel = (page: Page) => page.locator('[data-testid="terminal-panel"][data-active="true"]');
const chip = (page: Page, id: string) => page.locator(`[data-terminal-target="shell|agentic_process-${id}"]`);
const historyRow = (page: Page, id: string) => page.locator(`[data-testid="chat-history-row"][data-process-id="${id}"]`);

async function processData(api: APIRequestContext, id: string) {
  const response = await api.get(`${AP}/${id}`);
  expect(response.ok()).toBe(true);
  return (await response.json()).data;
}

async function observerIsIdle(page: Page) {
  await expect(panel(page)).toHaveCount(0);
  await expect(page.getByTestId('process-toolbar')).toHaveCount(0);
  // ProjectHome may show its generic new-chat composer; no process-owned
  // composer or terminal runtime may be mounted in this observer.
  await expect(page.locator('[data-testid="terminal-panel"] [data-testid="entity-execution-input"]')).toHaveCount(0);
  await expect(page.locator('.xterm')).toHaveCount(0);
}

async function screenshot(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

test('two browsers receive native title changes and same-text pinning with an idle observer', async ({ browser }, testInfo) => {
  test.skip(!enabled || !workspaceRoot || !nativeRoot, 'Requires explicit isolated native-fixture environment');
  expect(process.env.FLOW_INSTANCE).toBeTruthy();
  const api = await apiContext();
  const sessionId = randomUUID(); // Native worker identity, not a Flowpad entity id.
  const workdir = join(workspaceRoot!, `observer-${sessionId}`);
  const nativeDir = join(nativeRoot!, 'session-state', sessionId);
  mkdirSync(workdir, { recursive: true });
  mkdirSync(nativeDir, { recursive: true });
  let projectId: string | undefined;
  let id: string | undefined;
  const snapshots: unknown[] = [];
  const publisherContext = await browser.newContext();
  const observerContext = await browser.newContext();
  await publisherContext.addInitScript(() => localStorage.setItem('llm-setup-modal-seen', 'true'));
  await observerContext.addInitScript(() => localStorage.setItem('llm-setup-modal-seen', 'true'));
  const publisher = await publisherContext.newPage();
  const observer = await observerContext.newPage();
  const nativeMetadata = (title: string | null, revision: number) => {
    const lines = [`id: ${sessionId}`, `cwd: ${JSON.stringify(workdir)}`, 'user_named: false',
      `updated_at: ${new Date(1_800_000_000_000 + revision * 1000).toISOString()}`];
    if (title) lines.push(`name: ${JSON.stringify(title)}`);
    const temporary = join(nativeDir, 'workspace.yaml.next');
    writeFileSync(temporary, lines.join('\n') + '\n');
    renameSync(temporary, join(nativeDir, 'workspace.yaml'));
  };
  try {
    nativeMetadata(null, 0);
    writeFileSync(join(nativeDir, 'events.jsonl'), JSON.stringify({
      type: 'session.start', id: randomUUID(), timestamp: new Date().toISOString(),
      data: { sessionId, cwd: workdir },
    }) + '\n');
    const projectResponse = await api.post('/api/v1/graph/project', {
      data: { type: 'project', name: 'naming-observer-fixture', fs_storage_mount_path: workdir },
    });
    expect(projectResponse.ok(), await projectResponse.text()).toBe(true);
    projectId = (await projectResponse.json()).data.id;
    const created = await api.post(AP, { data: {
      type: 'agentic_process', worker_type: 'copilot', workdir, project_id: projectId,
      session_id: sessionId, pty_mode: false, auto_rename: true,
    } });
    expect(created.ok(), await created.text()).toBe(true);
    id = (await created.json()).data.id;

    // Open the observer before any process tab exists. It never selects a
    // process, even when the other browser later materializes a shared Tab.
    await observer.goto(withViewMode(`/dock/project/${projectId}`, 'standard'));
    await observer.locator('[data-rail-item="chats"]').click();
    await expect(observer.getByRole('button', { name: 'Current project: naming-observer-fixture', exact: true }))
      .toHaveAttribute('aria-pressed', 'true');
    await observerIsIdle(observer);

    await publisher.goto(withViewMode(`/dock/shell/agentic_process-${id}`, 'standard'));
    await expect(panel(publisher)).toHaveAttribute('data-pty-mode', 'false');
    await observerIsIdle(observer);

    const expectBoth = async (name: string) => {
      await expect(panel(publisher).getByTestId('process-header-name')).toHaveText(name);
      for (const page of [publisher, observer]) {
        await expect(chip(page, id!)).toContainText(name);
        await expect(historyRow(page, id!)).toContainText(name);
      }
      await observerIsIdle(observer);
    };
    const recordPhase = async (phase: string, stage = phase) => {
      const process = await processData(api, id!);
      expect(process.naming_state.phase).toBe(phase);
      expect(process.session_id).toBe(sessionId);
      expect(process.shell_id ?? null).toBeNull();
      expect(process.worker_pid ?? null).toBeNull();
      snapshots.push({ stage, phase, process, observerUrl: observer.url() });
      await screenshot(observer, testInfo, `observer-${stage}`);
    };

    // Controlled first-input event; it exercises production fallback policy
    // without sending a prompt to a paid worker.
    const reported = await api.get(`${AP}/${id}/report_event/first_prompt`, {
      params: { data: JSON.stringify({ prompt: fallback }) },
    });
    expect(reported.ok(), await reported.text()).toBe(true);
    await expectBoth(fallback);
    await recordPhase('prompt_fallback');

    // The real native-file watcher, adapter, transaction and WebSocket fan-out
    // must promote B over C in both independently connected browser contexts.
    nativeMetadata(harnessTitle, 1);
    await expectBoth(harnessTitle);
    await recordPhase('harness');

    // Confirm the existing title without changing any character. This is an
    // explicit user choice and must still call the tab rename action.
    await chip(publisher, id!).getByText(harnessTitle, { exact: true }).dblclick();
    const editor = chip(publisher, id!).locator('input');
    await expect(editor).toHaveValue(harnessTitle);
    await editor.press('Enter');
    await expect.poll(async () => (await processData(api, id!)).naming_state.phase).toBe('user_pinned');
    await expectBoth(harnessTitle);
    await recordPhase('user_pinned', 'same-text-pin');
    const before = await processData(api, id!);
    const cursor = before.naming_state.cursors['copilot.workspace'].revision;

    nativeMetadata(laterTitle, 2);
    // Advancing the source cursor proves the late automatic title was consumed,
    // rather than passing because the watcher never saw the update.
    await expect.poll(async () => (await processData(api, id!)).naming_state.cursors['copilot.workspace'].revision)
      .not.toBe(cursor);
    await expectBoth(harnessTitle);
    expect((await processData(api, id!)).auto_rename).toBe(false);
    await recordPhase('user_pinned', 'pinned-after-late-native-title');
    await screenshot(publisher, testInfo, 'publisher-pinned-after-late-native-title');
  } finally {
    const path = testInfo.outputPath('controlled-native-observations.json');
    writeFileSync(path, JSON.stringify({ evidence: 'controlled native metadata; no CLI/model call', snapshots }, null, 2));
    await testInfo.attach('controlled-native-observations', { path, contentType: 'application/json' });
    await publisherContext.close();
    await observerContext.close();
    if (id) await api.delete(`${AP}/${id}`);
    if (projectId) await api.delete(`/api/v1/graph/project/${projectId}`);
    await api.dispose();
    rmSync(nativeDir, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});
