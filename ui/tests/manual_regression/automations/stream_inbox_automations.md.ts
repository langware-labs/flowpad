/**
 * Stream stream inbox automations, walked in a browser (docs/snippets/stream-inbox-automations.md, the v4 mock):
 *
 *   1. a message arrives on a channel (a loopback double) and is in the stream inbox;
 *   2. its quick ⚡ opens the two-box screen, prefilled with the channel;
 *   3. the sentence, the agent and the prompt are typed; the fast test answers "would catch";
 *      Try fills the list; Save turns the rule on;
 *   4. a second message arrives; the rule catches it; the chip "⚡ <agent>" appears on the
 *      message and the stream inbox row; the lifecycle line reads handling → replied;
 *   5. the chip opens the agent's session; the top-bar ⚡ counts it; the list row shows a mark.
 *
 * Runs against an instance whose backend is `tests/e2e/mock_worker_backend.py` with `MOCK_DECISION=1`
 * (every agent turn answers from the mock worker; the Decision API answers "yes 0.9" from the double):
 *
 *   scripts/instance_ctl.sh launch auto-7          # then swap its backend (the module's docstring)
 *   set -a; source .env.auto-7.local; set +a; MOCK_DECISION=1 uv run python tests/e2e/mock_worker_backend.py
 *   cd ui && FLOW_INSTANCE=auto-7 VITE_PORT=5056 npx playwright test --config tests/manual_regression/automations/playwright.config.ts stream_inbox
 *
 * Guards: no page errors, no ≥400 from `/graph/trigger`, every click navigates by URL.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { REPO_ROOT, apiContext, apiOrigin, configuredFileEnv } from '../_shared/api';
import { dismissSetupModal } from '../triggers/helpers';

const INSTANCE = process.env.FLOW_INSTANCE || '';
const CHANNEL = 'telegram';
const SHOTS = process.env.AUTOMATIONS_SHOTS || '';

interface ChannelEntry {
  config: Record<string, unknown>;
  fields?: Record<string, unknown>;
  secret_store?: { type: string; config: Record<string, unknown> };
  sender: string;
}

let api: APIRequestContext;
let doubles: ChildProcessWithoutNullStreams | undefined;
let control = '';
let agentId = '';
let sourceId = '';
let ruleId = '';
const pageErrors: string[] = [];
const badResponses: string[] = [];

async function controlJson<T>(method: 'GET' | 'POST', route: string, body?: unknown): Promise<T> {
  const res = await api.fetch(`${control}${route}`, { method, data: body });
  expect(res.ok(), `${method} ${route}: ${await res.text()}`).toBeTruthy();
  return (await res.json()) as T;
}

async function graph<T = Record<string, unknown>>(method: 'get' | 'post' | 'delete', route: string, data?: unknown): Promise<T> {
  const res = await api[method](`/api/v1${route}`, data === undefined ? undefined : { data });
  const json = await res.json();
  expect(res.ok() && json.status === 'SUCCESS', `${method} ${route}: ${JSON.stringify(json).slice(0, 300)}`).toBeTruthy();
  return json.data as T;
}

async function deliverAndSync(text: string) {
  await controlJson('POST', '/deliver', { channel: CHANNEL, text });
  const report = await graph<{ health?: string; error_detail?: string }>('post', `/graph/data_source/${sourceId}/sync`, {});
  expect(report.health, `sync ${report.error_detail ?? ''}`).toBe('ok');
}

/** The conversation the source's messages land in — the row is found by its id, not by text (the
 *  double stamps one time on every delivery, so a row's preview may show an earlier message). */
async function conversationOfSource(): Promise<string> {
  // The sync answers once the items are stored; the projection into a conversation follows on the bus.
  let found: { id: string } | undefined;
  await expect
    .poll(async () => {
      const rows = await graph<Array<{ id: string; channel_source_id?: string | null }>>('get', '/graph/conversation');
      found = rows.find((c) => c.channel_source_id === sourceId);
      return found?.id;
    }, { message: 'no conversation for the source' })
    .toBeTruthy();
  return found!.id;
}

async function open(page: Page, route: string) {
  await dismissSetupModal(page);
  await page.goto(route);
  const skip = page.getByRole('button', { name: 'Skip' });
  if (await skip.isVisible({ timeout: 2_000 }).catch(() => false)) await skip.click();
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => document.documentElement.classList.toggle('dark', t === 'dark'), theme);
    await page.screenshot({ path: `${SHOTS}/${name}-${theme}.png`, fullPage: false });
  }
  await page.evaluate(() => document.documentElement.classList.remove('dark'));
}

test.describe.configure({ mode: 'serial' });
test.setTimeout(240_000);

test.beforeAll(async () => {
  api = await apiContext();
  doubles = spawn('uv', ['run', 'python', 'tests/e2e/channel_doubles.py', '--backend', apiOrigin(), '--channels', CHANNEL], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...configuredFileEnv(), FLOW_INSTANCE: INSTANCE, FLOWPAD_SKIP_DOTENV: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  doubles.stderr.setEncoding('utf8');
  doubles.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  control = await new Promise<string>((resolve, reject) => {
    let buffer = '';
    doubles!.stdout.setEncoding('utf8');
    doubles!.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      const line = buffer.split('\n').find((l) => l.includes('"control"'));
      if (line) resolve((JSON.parse(line) as { control: string }).control);
    });
    doubles!.on('exit', (code, signal) => reject(new Error(`channel doubles exited with ${code ?? signal}\n${stderr.slice(-2000)}`)));
  });
  const channels = await controlJson<Record<string, ChannelEntry>>('GET', '/channels');
  const entry = channels[CHANNEL];
  expect(entry, `the doubles host no ${CHANNEL}`).toBeTruthy();

  const agent = await graph<{ id: string }>('post', '/graph/agent', {
    name: `Billing helper ${Date.now().toString(36)}`,
    worker_type: 'claude',
    system_prompt: 'You handle refunds.',
  });
  agentId = agent.id;
  const body: Record<string, unknown> = {
    name: `Support chat ${Date.now().toString(36)}`,
    provider: CHANNEL,
    config: entry.config,
    inbound_allowed_senders: [],
    ...(entry.fields ?? {}),
  };
  if (entry.secret_store) body.secret_store = entry.secret_store;
  const source = await graph<{ id: string }>('post', '/graph/data_source', body);
  sourceId = source.id;
  await graph('post', `/graph/data_source/${sourceId}/verify`, {});
});

test.afterAll(async () => {
  if (ruleId) await api.delete(`/api/v1/graph/trigger/${ruleId}/delete`).catch(() => undefined);
  if (sourceId) await api.delete(`/api/v1/graph/data_source/${sourceId}`).catch(() => undefined);
  if (agentId) await api.delete(`/api/v1/graph/agent/${agentId}`).catch(() => undefined);
  if (doubles && control) {
    const exited = new Promise<void>((resolve) => doubles!.once('exit', () => resolve()));
    await api.post(`${control}/shutdown`).catch(() => undefined);
    await exited;
  }
});

test.beforeEach(({ page }) => {
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('response', (r) => {
    if (r.url().includes('/graph/trigger') && r.status() >= 400 && ![404, 422].includes(r.status()))
      badResponses.push(`${r.status()} ${r.url()}`);
  });
});

test('1. a message arrives; its quick ⚡ opens the two-box screen prefilled', async ({ page }) => {
  const nonce = Math.random().toString(36).slice(2, 8);
  await deliverAndSync(`I was charged twice for October, please refund one ${nonce}`);
  const conversationId = await conversationOfSource();
  await open(page, '/dock/stream_inbox');
  const row = page.locator(`[data-testid="stream-inbox-conversation-row"][data-conversation-id="${conversationId}"]`);
  await expect(row).toHaveCount(1);
  await row.click();
  const bubble = page.locator('[data-testid^="message-bubble-"]').filter({ hasText: nonce });
  await expect(bubble).toBeVisible();
  await bubble.hover();
  await bubble.locator('[data-testid^="message-automate-quick-"]').click();
  await expect(page).toHaveURL(/\/dock\/automations\?creating=message&source=/);
  await expect(page.getByTestId('message-rule-page')).toBeVisible();
  await expect(page.getByTestId(`message-rule-source-${sourceId}`)).toHaveAttribute('aria-pressed', 'true');
  await shot(page, 'stream-inbox-rule-new');
});

test('2. sentence, agent, prompt; the fast test and Try answer; Save turns it on', async ({ page }) => {
  await open(page, `/dock/automations?creating=message&source=${sourceId}`);
  await page.getByTestId('message-rule-catch-text').fill('asks for a refund or disputes a charge');
  await page.getByTestId('message-rule-agent').selectOption(`agent-${agentId}`);
  await page.getByTestId('message-rule-prompt').fill('Draft the reply in the conversation. Do not send it.');
  await page.getByTestId('message-rule-sample').fill('Hi, I was billed for a plan I cancelled. Can you reverse it?');
  // The fast test asks the double about the sentence as typed — nothing saved yet.
  await page.getByTestId('message-rule-fast-test-run').click();
  await expect(page.getByTestId('message-rule-fast-test-verdict')).toHaveAttribute('data-verdict', 'yes');
  await page.getByTestId('automation-save').click();
  await expect(page).toHaveURL(/\/dock\/automations\?trigger=/);
  ruleId = new URL(page.url()).searchParams.get('trigger') ?? '';
  expect(ruleId).toBeTruthy();
  await page.getByTestId('message-rule-try-run').click();
  const rows = page.getByTestId('message-rule-try-row');
  await expect(rows.first()).toBeVisible();
  await expect(rows.first()).toHaveAttribute('data-verdict', 'yes');
  await expect(page.getByTestId('message-rule-enabled')).toHaveAttribute('data-state', 'checked');
  const rule = await graph<{ gate?: { sentence?: string }; then?: { run_agent?: { agent?: string } }; enabled?: boolean }>('get', `/graph/trigger/${ruleId}`);
  expect(rule.gate?.sentence).toBe('asks for a refund or disputes a charge');
  expect(rule.then?.run_agent?.agent).toBe(`agent-${agentId}`);
  expect(rule.enabled).toBe(true);
  await shot(page, 'stream-inbox-rule-tried');
});

test('3. a second message is caught: the chip on the message and the row, the lifecycle, the session', async ({ page }) => {
  const nonce = Math.random().toString(36).slice(2, 8);
  await deliverAndSync(`Please refund the duplicate charge from last week ${nonce}`);
  // The fire: one run for the rule, with the decision and the session it started.
  await expect
    .poll(async () => {
      const runs = await graph<Array<{ status: string; agentic_process_id?: string | null; decision?: { caught?: boolean } }>>(
        'get',
        `/graph/trigger/runs?trigger_id=${ruleId}&include_tests=false`,
      );
      return runs.find((r) => r.decision?.caught && r.agentic_process_id) ? 'caught' : runs.map((r) => r.status).join(',');
    }, { message: 'the rule never caught the message' })
    .toBe('caught');

  const conversationId = await conversationOfSource();
  await open(page, '/dock/stream_inbox');
  const row = page.locator(`[data-testid="stream-inbox-conversation-row"][data-conversation-id="${conversationId}"]`);
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId('stream-inbox-row-automation')).toBeVisible();
  await row.click();
  const bubble = page.locator('[data-testid^="message-bubble-"]').filter({ hasText: nonce });
  const chip = bubble.getByTestId('message-automation-chip');
  await expect(chip).toBeVisible();
  await expect(chip).toContainText('Billing helper');
  // The mock worker answers at once; the line settles on replied, or handling on the way there.
  await expect(page.getByTestId('message-lifecycle').first()).toHaveAttribute('data-state', /handling|replied/);
  await shot(page, 'stream-inbox-caught');

  await chip.click();
  await expect(page).toHaveURL(/\/dock\/process-runs\?run=/);
  await shot(page, 'stream-inbox-session');

  // The top bar counts it; the list row carries a mark.
  await expect(page.getByTestId('top-nav-automations-badge')).toHaveText(/^[1-9]/);
  await page.getByTestId('top-nav-automations').click();
  await expect(page).toHaveURL(/\/dock\/automations$/);
  await expect(page.getByTestId(`automation-marks-${ruleId}`)).toBeVisible();
  await expect(page.getByTestId(`automation-counts-${ruleId}`)).toContainText('caught');
  await shot(page, 'stream-inbox-list');

  expect(pageErrors, 'page errors').toEqual([]);
  expect(badResponses, 'trigger responses ≥ 400').toEqual([]);
});
