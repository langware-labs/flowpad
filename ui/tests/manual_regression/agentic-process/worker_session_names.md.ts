/** Real workers and real browser/FlowSync: no routed fixtures or source assertions.
 * Run only with an exclusively owned named instance and isolated provider homes.
 * NAMING_WORKSPACE_ROOT must be a disposable directory outside history's excluded
 * OS-temp prefixes so the real Chats sidebar can discover these sessions.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import { apiContext } from '../_shared/api';
import { selectViewMode, withViewMode } from '../_shared/view-mode';

const workers = [
  { type: 'claude_code', model: 'sm' },
  // The portable sm tier currently maps to gpt-5.4-mini, which this ChatGPT
  // account rejects. Use the model verified by the isolated Codex CLI lab.
  { type: 'codex', model: 'gpt-5.6-terra' },
  { type: 'copilot', model: 'auto' },
  { type: 'opencode', model: 'opencode/big-pickle' },
];
const workspaceRoot = process.env.NAMING_WORKSPACE_ROOT;
const selected = process.env.NAMING_WORKER;
const AP = '/api/v1/graph/agentic_process';

async function processData(api: APIRequestContext, id: string) {
  const response = await api.get(`${AP}/${id}`);
  expect(response.ok()).toBe(true);
  return (await response.json()).data;
}

const panel = (page: Page) => page.locator('[data-testid="terminal-panel"][data-active="true"]');
const chip = (page: Page, id: string) => page.locator(`[data-terminal-target="shell|agentic_process-${id}"]`);
const historyRow = (page: Page, id: string) => page.locator(`[data-testid="chat-history-row"][data-process-id="${id}"]`);

async function attachJson(testInfo: TestInfo, name: string, value: unknown) {
  const path = testInfo.outputPath(`${name}.json`);
  writeFileSync(path, JSON.stringify(value, null, 2));
  await testInfo.attach(name, { path, contentType: 'application/json' });
}

async function captureScreenshot(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

async function sendPrompt(page: Page, text: string, pty: boolean) {
  if (pty) {
    const terminal = panel(page).getByRole('textbox', { name: 'Terminal input', exact: true });
    await expect(terminal).toBeEnabled();
    await terminal.pressSequentially(text);
    // Confirm the CLI composer actually received the text before submitting;
    // xterm's hidden textarea being present does not establish PTY delivery.
    await expect(panel(page).locator('.xterm-rows')).toContainText(text);
    await terminal.press('Enter');
  } else {
    const composer = panel(page).getByTestId('entity-execution-input');
    await expect(composer).toBeEnabled();
    await composer.fill(text);
    await composer.press('Enter');
  }
}

async function expectNames(page: Page, id: string, name: string) {
  await expect(panel(page).getByTestId('process-header-name')).toHaveText(name);
  await expect(chip(page, id)).toContainText(name);
  await expect(historyRow(page, id)).toContainText(name.length > 80 ? `${name.slice(0, 80)}…` : name);
}

for (const worker of workers.filter((candidate) => !selected || candidate.type === selected)) {
  for (const pty of [false, true]) {
    test.describe(`${worker.type} ${pty ? 'PTY' : 'headless'} naming`, () => {
      test.describe.configure({ mode: 'serial' });
      test.skip(!workspaceRoot, 'Set NAMING_WORKSPACE_ROOT and FLOW_INSTANCE for a disposable live naming run');
      let api: APIRequestContext;
      let id: string;
      let sessionId: string;
      let chosenName: string;
      let projectId: string;
      let projectName: string;
      const mode = pty ? 'advanced' : 'standard';

      test.beforeAll(async () => {
        expect(process.env.FLOW_INSTANCE).toBeTruthy();
        api = await apiContext();
        const bootstrap = await api.get('/api/v1/graph/bootstrap');
        const data = (await bootstrap.json()).data;
        expect(data.types?.length).toBeGreaterThan(0);
        const workdir = join(workspaceRoot!, `${worker.type}-${mode}-${Date.now()}`);
        mkdirSync(workdir, { recursive: true });
        projectName = `${worker.type}-${mode}-names`;
        const projectResponse = await api.post('/api/v1/graph/project', {
          data: { type: 'project', name: projectName, fs_storage_mount_path: workdir },
        });
        expect(projectResponse.ok(), await projectResponse.text()).toBe(true);
        projectId = (await projectResponse.json()).data.id;
        const project = (await (await api.get(`/api/v1/graph/project/${projectId}`)).json()).data;
        expect(project.fs_storage_mount_path).toBe(workdir);
        const response = await api.post('/api/v1/graph/compute_node/@local/createProcess', {
          data: {
            context: { workdir, worker_type: worker.type, model: worker.model,
              project_id: projectId, permission_mode: 'bypassPermissions',
              load_flowpad_assistant: false },
            visible: pty, pty_mode: pty,
          },
        });
        expect(response.ok(), await response.text()).toBe(true);
        id = (await response.json()).data.id;
        expect((await processData(api, id)).project_id).toBe(projectId);
        const history = await api.get('/api/v1/graph/compute_node/@local/worker-history', {
          params: { project_ids: projectId, limit: '50' },
        });
        expect(history.ok(), await history.text()).toBe(true);
      });

      test.beforeEach(async ({ page }) => {
        await page.addInitScript(() => localStorage.setItem('llm-setup-modal-seen', 'true'));
        await page.goto(withViewMode(`/dock/shell/agentic_process-${id}`, mode));
        await expect(panel(page)).toHaveAttribute('data-pty-mode', String(pty));
        // The project and native CLI cwd are the same disposable directory.
        // Prove the loader selected that project before submitting a model turn.
        await expect(page.getByRole('button', { name: `Current project: ${projectName}`, exact: true }))
          .toHaveAttribute('aria-pressed', 'true');
      });

      test.afterEach(async ({ page }, testInfo) => {
        if (!id || testInfo.status === testInfo.expectedStatus) return;
        const process = await processData(api, id);
        const tabsResponse = await api.get('/api/v1/graph/tab/list_all');
        const tabs = (await tabsResponse.json()).data.tabs.filter((tab: { target_id?: string }) => tab.target_id === id);
        await attachJson(testInfo, 'failed-runtime', { process, tabs, url: page.url() });
      });

      test.afterAll(async () => {
        if (id) await api.delete(`${AP}/${id}`);
        if (projectId) await api.delete(`/api/v1/graph/project/${projectId}`);
        await api?.dispose();
      });

      test('a real first turn names the tab, header and sidebar without refresh', async ({ page }, testInfo) => {
        const prompt = `Ref ${id.slice(0, 6)}. Why is the ocean blue? One sentence.`;
        await sendPrompt(page, prompt, pty);
        await expect.poll(async () => (await processData(api, id)).name).toBeTruthy();
        await expect.poll(async () => {
          const response = await api.post(`${AP}/${id}/transcript/full`, { data: {} });
          const transcript = (await response.json()).data;
          return transcript.entries.some((entry: { kind?: string }) => entry.kind === 'assistant_message');
        }).toBe(true);
        const process = await processData(api, id);
        sessionId = process.session_id;
        await expectNames(page, id, process.name);
        await attachJson(testInfo, 'resolved-name', { id, sessionId,
          name: process.name, naming_state: process.naming_state, model: worker.model });
        await captureScreenshot(page, testInfo, 'named-surfaces');
      });

      test('explicit rename pins every surface and survives a later real turn', async ({ page }, testInfo) => {
        chosenName = `123 ${worker.type} ${mode}`;
        await chip(page, id).getByText((await processData(api, id)).name, { exact: true }).dblclick();
        const editor = chip(page, id).locator('input');
        await editor.fill(chosenName);
        await editor.press('Enter');
        await expect.poll(async () => (await processData(api, id)).auto_rename).toBe(false);
        await expectNames(page, id, chosenName);
        await sendPrompt(page, 'Explain why leaves are green. Reply with one short sentence.', pty);
        await expect.poll(async () => {
          const response = await api.post(`${AP}/${id}/transcript/prompts`, { data: {} });
          return JSON.stringify((await response.json()).data).includes('leaves are green');
        }).toBe(true);
        await expect.poll(async () => {
          const response = await api.post(`${AP}/${id}/transcript/full`, { data: {} });
          return (await response.json()).data.entries.filter((entry: { kind?: string }) =>
            entry.kind === 'assistant_message').length;
        }).toBeGreaterThanOrEqual(2);
        await expectNames(page, id, chosenName);
        expect((await processData(api, id)).session_id).toBe(sessionId);
        await captureScreenshot(page, testInfo, 'pinned-surfaces');
      });

      test('reload, close/reopen and transport round-trip preserve the pinned name', async ({ page }, testInfo) => {
        await page.reload();
        await expectNames(page, id, chosenName);
        // Keep this project's home selected while closing its process tab.
        // Closing a selected last chat legitimately switches navigator kinds.
        await page.getByRole('button', { name: 'Open project home', exact: true }).click();
        await expect(page).toHaveURL(new RegExp(`/project/${projectId}`));
        await chip(page, id).getByRole('button', { name: 'Close tab', exact: true }).click();
        await expect(chip(page, id)).toHaveCount(0);
        await page.locator('[data-rail-item="chats"]').click();
        await historyRow(page, id).click();
        await expectNames(page, id, chosenName);
        await selectViewMode(page, pty ? 'standard' : 'advanced');
        await expect(panel(page)).toHaveAttribute('data-pty-mode', String(!pty));
        await expectNames(page, id, chosenName);
        await selectViewMode(page, mode);
        await expect(panel(page)).toHaveAttribute('data-pty-mode', String(pty));
        await expectNames(page, id, chosenName);
        const process = await processData(api, id);
        expect(process.session_id).toBe(sessionId);
        expect(process.auto_rename).toBe(false);
        await captureScreenshot(page, testInfo, 'restored-surfaces');
      });
    });
  }
}
