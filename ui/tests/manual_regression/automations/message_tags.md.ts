/** Real application/browser acceptance for message-tags-20261114.
 * Backend: tests/e2e/mock_worker_backend.py, MOCK_DECISION=1 MOCK_DECISION_MATCH=1 MOCK_MESSAGE_CLASSIFIER=1.
 * Only the Decision API and the automation executor are doubled; HTTP, DB, bus and WS are real.
 * The classifier picks ONE tag under the root (the decision double: the meaning the message mentions most).
 * Run on a disposable instance, never prod. The final test fails closed on
 * missing approved mock coverage, including skipped/unfinished scenario work.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { apiContext, apiOrigin, configuredFileEnv, REPO_ROOT } from '../_shared/api';
import { dismissSetupModal } from '../triggers/helpers';
import { approvedMock, MessageTagsCoverage } from './message-tags-coverage';

const coverage = new MessageTagsCoverage();
const prefix = 'qa.message-tags';
const tagNames = ['billing.refund', 'priority.today', 'message.action-required', 'billing.receipt', 'billing.review']
  .map((name) => `${prefix}.${name}`);
let body = `Charged twice for November ${Date.now()}`;
let api: APIRequestContext;
let doubles: ChildProcess;
let control = '';
let sourceId = '';
let conversationId = '';
let messageId = '';
let conversationURL = '';
const rules: Array<{ id: string; name: string }> = [];
const diagnostics: string[] = [];
const executorControl = process.env.MOCK_MESSAGE_TAG_CONTROL_PORT || configuredFileEnv().MOCK_MESSAGE_TAG_CONTROL_PORT;

type Message = { id: string; text: string; conversation_id?: string; tags: string[]; message_processing?: {
  classification: string;
  assignments: Record<string, { source: string; trigger_id?: string; run_id?: string }>;
  queue: Array<{ id: string; trigger_id: string; status: string; run_id?: string }>;
} };

async function graph<T = Record<string, unknown>>(method: 'get' | 'post' | 'delete', route: string, data?: unknown): Promise<T> {
  const response = await api[method](`/api/v1/graph/${route}`, data === undefined ? undefined : { data });
  const result = await response.json();
  expect(response.ok() && result.status === 'SUCCESS', `${method} ${route}: ${JSON.stringify(result)}`).toBe(true);
  return result.data as T;
}

async function message(): Promise<Message> { return graph('get', `flow_message/${messageId}`); }
async function openMessage(page: Page) {
  await page.goto(conversationURL);
  await expect(page.getByTestId(`message-bubble-${messageId}`)).toBeVisible();
}
function tags(page: Page) { return page.getByTestId(`message-bubble-${messageId}`).getByTestId('message-tags'); }
function streamInboxRow(page: Page, id = conversationId) {
  return page.locator(`[data-testid="stream-inbox-conversation-row"][data-conversation-id="${id}"]`);
}
async function openQueue(page: Page) {
  await tags(page).getByTestId('message-automation-queue').click();
  await expect(page.getByTestId('message-automation-queue-panel')).toBeVisible();
}
async function picker(page: Page) {
  await tags(page).getByTestId('message-tags-menu').click();
  await expect(page.getByTestId('message-tags-picker')).toBeVisible();
}

test.describe.configure({ mode: 'serial' });
// Same headless WebGL support as the existing tags browser suite.
test.use({ launchOptions: { args: ['--enable-unsafe-swiftshader'] } });
test.beforeAll(async () => {
  expect(process.env.FLOW_INSTANCE, 'set a disposable FLOW_INSTANCE').toMatch(/^tags-rig-/);
  api = await apiContext();
  if (process.env.MESSAGE_TAGS_EXISTING_MESSAGE) {
    messageId = process.env.MESSAGE_TAGS_EXISTING_MESSAGE;
    const existing = await graph<Message>('get', `flow_message/${messageId}`);
    body = existing.text;
    conversationId = existing.conversation_id!;
    conversationURL = `/dock/conversation/${conversationId}`;
    for (const entry of existing.message_processing!.queue) rules.push(await graph('get', `trigger/${entry.trigger_id}`));
    return;
  }
  await graph('post', 'flow_message/classification-settings', { enabled: true, include_flow_tags: false, root: prefix });
  const previous = await graph<Array<{ id: string; name: string }>>('get', 'trigger');
  for (const rule of previous.filter((item) => ['Refund helper', 'Flag for today', 'Review refund'].includes(item.name))) {
    await graph('delete', `trigger/${rule.id}`);
  }
  for (const [index, name] of tagNames.entries()) {
    await graph('post', 'tag', { name, title: name.split('.').at(-1), description: index === 0 ? 'Charged twice for a month' : `Acceptance meaning: ${name}`, stream_inbox: true,
      color: ['#3b82f6', '#eab308', '#f97316', '#22c55e', '#a855f7'][index] });
  }
  for (const [index, name] of ['Refund helper', 'Flag for today', 'Review refund'].entries()) {
    const rule = await graph<{ id: string; name: string }>('post', 'trigger', {
      name, trigger_type: 'tag', tag_pattern: 'stream_inbox.*.message.projected', enabled: true,
      message_tags: [tagNames[index === 2 ? 4 : index]],
      ...(index === 1 ? { then: { run_script: 'true' } } : { actions: [{ action_type: 'callback',
        callback_name: index === 0 ? 'message_tags_acceptance_refund' : 'message_tags_acceptance_review' }] }),
    });
    rules.push(rule);
    expect(await graph('get', `trigger/${rule.id}`), 'tag trigger configuration must round-trip before delivery')
      .toMatchObject({ message_tags: [tagNames[index === 2 ? 4 : index]] });
  }
  doubles = spawn('uv', ['run', 'python', 'tests/e2e/channel_doubles.py', '--backend', apiOrigin(), '--channels', 'telegram'], {
    cwd: REPO_ROOT, env: { ...process.env, ...configuredFileEnv(), FLOWPAD_SKIP_DOTENV: 'true' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  control = await new Promise<string>((resolve, reject) => {
    let buffer = '', errors = '';
    doubles.stderr!.on('data', (chunk) => { errors += String(chunk); });
    doubles.stdout!.on('data', (chunk) => {
      buffer += String(chunk);
      const line = buffer.split('\n').find((value) => value.includes('"control"'));
      if (line) resolve(JSON.parse(line).control);
    });
    doubles.on('exit', (code) => reject(new Error(`channel fixture exited ${code}: ${errors}`)));
  });
  const channels = await (await api.get(`${control}/channels`)).json();
  const entry = channels.telegram;
  const source = await graph<{ id: string }>('post', 'data_source', { name: `Message tags acceptance stream_inbox ${Date.now()}`, provider: 'telegram',
    config: entry.config, inbound_allowed_senders: [], ...entry.fields, ...(entry.secret_store ? { secret_store: entry.secret_store } : {}) });
  sourceId = source.id;
  await graph('post', `data_source/${sourceId}/verify`, {});
});

test.beforeEach(async ({ page }) => {
  await dismissSetupModal(page);
  page.on('pageerror', (error) => diagnostics.push(`pageerror ${error.message}`));
  page.on('console', (event) => { if (event.type() === 'error') diagnostics.push(`console ${event.text()}`); });
  page.on('response', (response) => { if (response.status() >= 400) diagnostics.push(`${response.status()} ${response.url()}`); });
});
// Playwright requires a destructured fixture argument even when only TestInfo is used.
// eslint-disable-next-line no-empty-pattern
test.afterEach(async ({}, info) => {
  for (const [name, value] of [['browser-diagnostics', diagnostics], ['mock-coverage-so-far', coverage.report()]] as const) {
    const path = info.outputPath(`${name}.json`);
    await writeFile(path, JSON.stringify(value, null, 2));
    await info.attach(name, { path, contentType: 'application/json' });
  }
});
test.afterAll(async () => {
  if (control) await api.post(`${control}/shutdown`);
  if (doubles && doubles.exitCode === null) doubles.kill('SIGTERM');
  await api?.dispose();
});

test('arrival classifies, updates mounted stream_inbox, and stays a single 36px row', async ({ page }, info) => {
  await page.goto('/dock/stream_inbox');
  expect((await api.post(`${control}/deliver`, { data: { channel: 'telegram', text: body, sender: String(Date.now()) } })).ok()).toBe(true);
  await graph('post', `data_source/${sourceId}/sync`, {});
  await expect.poll(async () => {
    const rows = await graph<Message[]>('get', 'flow_message');
    const arrived = rows.find((item) => item.text === body);
    conversationId = arrived?.conversation_id ?? '';
    messageId = arrived?.id ?? '';
    return conversationId;
  }).toBeTruthy();
  const row = streamInboxRow(page);
  await expect(row).toBeVisible();
  await expect.poll(async () => (await message()).message_processing?.classification).toMatch(/succeeded|failed|skipped/);
  expect((await message()).message_processing).toMatchObject({ classification: 'succeeded' });
  expect((await message()).message_processing!.assignments[tagNames[0]].source).toBe('classification');
  for (const name of [tagNames[1], tagNames[2]]) await graph('post', `flow_message/${messageId}/tags/${encodeURIComponent(name)}`);
  await expect(row.getByTestId('stream-inbox-message-tags')).toBeVisible();
  expect((await row.boundingBox())!.height).toBe(36);
  expect((await row.getByTestId('stream-inbox-message-tags').boundingBox())!.width).toBeLessThanOrEqual(112);
  await coverage.screen('stream_inbox', page, info);
  await coverage.action('stream_inbox', 'open', async () => {
    await row.click();
    await expect(page.locator('[data-testid^="message-bubble-"]').filter({ hasText: body })).toBeVisible();
  });
  conversationURL = page.url();
  const bubble = page.locator('[data-testid^="message-bubble-"]').filter({ hasText: body });
  messageId = (await bubble.getAttribute('data-testid'))!.replace('message-bubble-', '');
  await expect.poll(async () => (await message()).message_processing?.classification).toBe('succeeded');
  expect(executorControl, 'the acceptance executor must expose its correlated release gate').toBeTruthy();
  await expect.poll(async () => (await message()).message_processing?.queue.map((entry) => entry.status)).toEqual(['running', 'queued']);
  await expect.poll(async () => (await message()).tags).toContain(tagNames[3]);
  await expect(tags(page).locator(':scope > span > [data-message-tag]')).toHaveCount(3);
  await coverage.screen('message', page, info);
  await tags(page).getByTestId('message-automation-queue').click();
  await expect(page.getByTestId(`queue-entry-${rules[0].id}`)).toHaveAttribute('data-status', 'running');
  await expect(page.getByTestId(`queue-entry-${rules[1].id}`)).toHaveAttribute('data-status', 'queued');
  const waitingEntry = (await message()).message_processing!.queue[1];
  await expect(page.getByTestId(`queue-history-${waitingEntry.id}`)).toHaveCount(0);
  await coverage.screen('queue', page, info);
  await coverage.action('queue', 'next', async () => {
    const running = (await message()).message_processing!.queue[0];
    expect((await api.post(`http://127.0.0.1:${executorControl}/release/${running.run_id}`)).status()).toBe(204);
    await expect.poll(async () => (await message()).message_processing?.queue.map((entry) => entry.status)).toEqual(['succeeded', 'succeeded', 'running']);
    await expect(page.getByTestId(`queue-entry-${rules[2].id}`)).toHaveAttribute('data-status', 'running');
  });
  await coverage.screen('chained', page, info);
  await coverage.action('chained', 'next', async () => {
    const running = (await message()).message_processing!.queue[2];
    expect((await api.post(`http://127.0.0.1:${executorControl}/release/${running.run_id}`)).status()).toBe(204);
    await expect.poll(async () => (await message()).message_processing?.queue.map((entry) => entry.status)).toEqual(['succeeded', 'succeeded', 'succeeded']);
    expect((await message()).message_processing!.queue).toHaveLength(3);
    await expect(page.getByTestId(`queue-entry-${rules[2].id}`)).toHaveAttribute('data-status', 'succeeded');
  });
  await coverage.screen('once', page, info);
  await page.keyboard.press('Escape');
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.evaluate((dark) => document.documentElement.classList.toggle('dark', dark), theme === 'dark');
    const path = info.outputPath(`message-${theme}.png`);
    await page.screenshot({ path, animations: 'disabled' });
    await info.attach(`message-${theme}`, { path, contentType: 'image/png' });
  }
  await page.setViewportSize({ width: 760, height: 900 });
  await page.goto('/dock/stream_inbox');
  expect((await row.boundingBox())!.height).toBe(36);
  const narrowPath = info.outputPath('stream-inbox-narrow.png');
  await page.screenshot({ path: narrowPath, animations: 'disabled' });
  await info.attach('stream-inbox-narrow', { path: narrowPath, contentType: 'image/png' });
});

test('message tag and automation links resolve exact entities; back/reload retain state', async ({ page }, info) => {
  await openMessage(page);
  await coverage.action('message', 'tags', async () => picker(page));
  await coverage.screen('tag-picker', page, info);
  for (const [name, screen, action] of [
    [tagNames[0], 'tag-view', 'view'], [tagNames[1], 'tag-view-today', 'view-today'],
    [tagNames[2], 'tag-view-action-required', 'view-action-required'], [tagNames[3], 'tag-view-receipt', 'view-receipt'],
  ]) {
    await coverage.action('tag-picker', action, async () => {
      await page.getByTestId('message-tags-picker').locator(`[data-message-tag="${name}"] button`).first().click();
      await expect(page).toHaveURL((url) => decodeURIComponent(url.pathname) === `/dock/tag/graph/${name}`);
    });
    await coverage.screen(screen, page, info);
    await page.reload();
    await expect(page.locator('.graph-view-root')).toBeVisible();
    if (screen !== 'tag-view') {
      await coverage.action(screen, 'back', async () => {
        await page.getByTestId('tag-view-back').click();
        await expect(page.getByTestId('message-tags-picker')).toBeVisible();
      });
    } else {
      await openMessage(page);
      await picker(page);
    }
  }
  await coverage.action('tag-picker', 'source', async () => {
    await page.getByTestId('message-tags-picker').getByTestId(`tag-source-${tagNames[3]}`).click();
    await expect(page).toHaveURL(new RegExp(`trigger=${rules[0].id}`));
  });
  await coverage.screen('automation', page, info);
  const beforePreview = (await message()).message_processing!.queue;
  await coverage.action('automation', 'test', async () => {
    await page.getByTestId('message-rule-fast-test-run').click();
    await expect(page.getByTestId('message-rule-fast-test-verdict')).toHaveAttribute('data-verdict', 'yes');
  });
  expect((await message()).message_processing!.queue).toEqual(beforePreview);
  await coverage.screen('automation-test', page, info);
  await coverage.action('automation-test', 'back', async () => {
    await page.getByTestId('message-rule-preview-back').click();
    await expect(page).toHaveURL((url) => !url.searchParams.has('preview') && url.searchParams.get('trigger') === rules[0].id);
    await expect(page.getByTestId('message-rule-fast-test-verdict')).toHaveCount(0);
  });
});

test('tag removals affect only the chosen tag, persist, and preserve the message body', async ({ page }, info) => {
  for (const [index, screen, action] of [[0, 'removed-refund', 'remove-refund'], [1, 'relabelled', 'remove-today'],
    [2, 'removed-action-required', 'remove-action-required'], [3, 'removed-receipt', 'remove-receipt']] as const) {
    await graph('post', `flow_message/${messageId}/set-tags`, { tags: tagNames });
    await openMessage(page);
    await picker(page);
    await coverage.action('tag-picker', action, async () => {
      await page.getByTestId('message-tags-picker').getByRole('button', { name: `Remove tag ${tagNames[index]}`, exact: true }).click();
      await expect.poll(async () => (await message()).tags).toEqual(tagNames.filter((_, item) => item !== index));
    });
    await page.keyboard.press('Escape');
    await expect(page.getByTestId(`message-bubble-${messageId}`)).toContainText(body);
    await coverage.screen(screen, page, info);
    await page.reload();
    await expect(tags(page)).toBeVisible();
    expect((await message()).tags).not.toContain(tagNames[index]);
  }
  await picker(page);
  await coverage.action('tag-picker', 'clear', async () => {
    for (const name of (await message()).tags) {
      await page.getByTestId('message-tags-picker').getByRole('button', { name: `Remove tag ${name}`, exact: true }).click();
    }
    await expect.poll(async () => (await message()).tags).toEqual([]);
  });
  await page.keyboard.press('Escape');
  await coverage.screen('unmatched', page, info);
  await coverage.action('unmatched', 'tags', async () => picker(page));
});

test('tag viewer filters stream_inbox by URL and clears through the existing filter bar', async ({ page }, info) => {
  await graph('post', `flow_message/${messageId}/set-tags`, { tags: tagNames });
  await page.goto(`/dock/tag/graph/${encodeURIComponent(tagNames[0])}`);
  await expect(page.locator('.graph-view-root')).toBeVisible();
  await coverage.action('tag-view', 'filter', async () => {
    await page.getByTestId('tag-view-messages').click();
    await expect(page).toHaveURL((url) => url.searchParams.get('tags') === tagNames[0]);
    await expect(page.getByTestId('stream-inbox-tag-filter')).toContainText(tagNames[0]);
  });
  const row = streamInboxRow(page);
  await expect(row).toBeVisible();
  await coverage.screen('tagged-messages', page, info);
  await page.reload();
  await expect(row).toBeVisible();
  await coverage.action('tagged-messages', 'open', async () => {
    await row.click();
    await expect(page.getByTestId(`message-bubble-${messageId}`)).toContainText(body);
  });
  await page.goBack();
  expect(new URL(page.url()).searchParams.get('tags')).toBe(tagNames[0]);
});

test('manual reassignment uses the existing picker and does not rerun an automation', async ({ page }) => {
  await graph('post', `flow_message/${messageId}/set-tags`, { tags: tagNames.filter((name) => name !== tagNames[0]) });
  const before = (await message()).message_processing!.queue;
  await openMessage(page);
  await picker(page);
  await page.getByTestId('message-tags-picker').getByRole('combobox').fill(tagNames[0]);
  await page.getByTestId(`tag-suggestion-${tagNames[0]}`).click();
  await expect.poll(async () => (await message()).tags).toContain(tagNames[0]);
  await expect(page.getByTestId('message-picker-tags').locator(`[data-message-tag="${tagNames[0]}"]`)).toBeVisible();
  expect((await message()).message_processing!.assignments[tagNames[0]].source).toBe('manual');
  expect((await message()).message_processing!.queue).toEqual(before);
  await page.reload();
  await expect(page.getByTestId('message-tags-picker')).toBeVisible();
  await expect(page.getByTestId(`message-bubble-${messageId}`)).toContainText(body);
});

test('an unclassified arrival shows the crossed tag and allows manual correction', async ({ page }, info) => {
  const text = `unmatched-message ${Date.now()}`;
  await graph('post', 'flow_message/classification-settings', { root: `${prefix}.nothing-here` });
  try {
    await page.goto('/dock/stream_inbox');
    expect((await api.post(`${control}/deliver`, { data: { channel: 'telegram', text, sender: String(Date.now()) } })).ok()).toBe(true);
    await graph('post', `data_source/${sourceId}/sync`, {});
    let arrived: Message | undefined;
    await expect.poll(async () => {
      arrived = (await graph<Message[]>('get', 'flow_message')).find((item) => item.text === text);
      return arrived?.message_processing?.classification;
    }).toBe('succeeded');
    expect(arrived!.tags).toEqual([]);
    expect(arrived!.message_processing!.queue).toEqual([]);
    const row = streamInboxRow(page, arrived!.conversation_id);
    await expect(row).toBeVisible();
    expect((await row.boundingBox())!.height).toBe(36);
    await expect(row.getByTestId('message-tags-menu')).toHaveAttribute('aria-label', 'No tags — add one');
    await row.click();
    const bubble = page.getByTestId(`message-bubble-${arrived!.id}`);
    await expect(bubble).toContainText(text);
    await expect(bubble.getByTestId('message-automation-queue')).toHaveCount(0);
    await bubble.getByTestId('message-tags-menu').click();
    const menu = page.getByTestId('message-tags-picker');
    await expect(menu).toContainText('No tags yet');
    const path = info.outputPath('unmatched-message.png');
    await page.screenshot({ path, animations: 'disabled' });
    await info.attach('unmatched-message', { path, contentType: 'image/png' });
    await menu.getByRole('combobox').fill(tagNames[1]);
    await page.getByTestId(`tag-suggestion-${tagNames[1]}`).click();
    await expect.poll(async () => (await graph<Message>('get', `flow_message/${arrived!.id}`)).tags).toEqual([tagNames[1]]);
    await expect.poll(async () => (await graph<Message>('get', `flow_message/${arrived!.id}`)).message_processing?.queue.map((entry) => entry.status)).toEqual(['succeeded']);
    expect((await graph<Message>('get', `flow_message/${arrived!.id}`)).message_processing!.assignments[tagNames[1]].source).toBe('manual');
    await expect(bubble).toContainText(text);
  } finally {
    await graph('post', 'flow_message/classification-settings', { root: prefix });
  }
});

test('FIFO chaining is visible, cycles are suppressed, exact rule and run links work', async ({ page }, info) => {
  await graph('post', `flow_message/${messageId}/set-tags`, { tags: tagNames });
  await openMessage(page);
  await coverage.action('message', 'queue', async () => {
    await openQueue(page);
  });
  const queue = (await message()).message_processing!.queue;
  expect(queue.map((entry) => entry.trigger_id)).toEqual(rules.map((rule) => rule.id));
  expect(new Set(queue.map((entry) => entry.trigger_id)).size).toBe(3);
  for (const [index, screen] of ['automation', 'automation-today', 'automation-review'].entries()) {
    await page.getByTestId(`queue-entry-${rules[index].id}`).getByRole('button').first().click();
    await expect(page).toHaveURL(new RegExp(`trigger=${rules[index].id}`));
    await expect(page.getByTestId('message-rule-page')).toHaveAttribute('data-automation-id', rules[index].id);
    await coverage.screen(screen, page, info);
    await openMessage(page);
    await tags(page).getByTestId('message-automation-queue').click();
  }
  await coverage.action('once', 'history', async () => {
    await page.getByTestId(`queue-history-${queue[0].id}`).click();
    await expect(page).toHaveURL(new RegExp(`run=${queue[0].run_id}`));
    await expect(page.getByTestId('run-detail')).toHaveAttribute('data-status', 'succeeded');
    await expect(page.getByTestId('run-detail-automation')).toHaveText(rules[0].name);
  });
  await coverage.screen('history', page, info);
});

test('tag tree CRUD, rename aliases, color and Flowpad vocabulary settings', async ({ page }, info) => {
  await openMessage(page);
  await picker(page);
  await coverage.action('tag-picker', 'editor', async () => {
    await page.getByTestId('message-tags-manage').click();
    await expect(page.getByTestId('stream-inbox-tags-page')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Stream Inbox tags', exact: true })).toBeVisible();
  });
  await coverage.screen('tags', page, info);
  const created = `${prefix}.billing.new-review`;
  const successor = `${prefix}.billing.renamed-review`;
  await coverage.action('tags', 'create', async () => {
    await page.getByTestId(`stream-inbox-tag-add-${prefix}.billing`).click();
    await expect(page.getByTestId('stream-inbox-tag-child-name')).toBeVisible();
  });
  await coverage.screen('tag-create', page, info);
  await page.getByTestId('stream-inbox-tag-child-name').fill('new-review');
  await coverage.action('tag-create', 'save', async () => {
    await page.getByTestId('stream-inbox-tag-child-save').click();
    await expect(page.getByTestId(`stream-inbox-tag-row-${created}`)).toBeVisible();
  });
  await page.getByTestId('stream-inbox-tag-description').fill('Messages requiring a second billing review');
  await page.getByTestId('stream-inbox-tag-color').fill('#2563eb');
  await page.getByTestId('stream-inbox-tag-save').click();
  await expect(page.getByTestId('stream-inbox-tag-unsaved')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId(`stream-inbox-tag-row-${created}`)).toBeVisible();
  let definitions = await graph<Array<{ name: string; color?: string; alias_of?: string; deprecated?: boolean }>>('get', 'tag');
  expect(definitions.find((tag) => tag.name === created)?.color).toBe('#2563eb');
  await page.goto(`/dock/tag/graph/${encodeURIComponent(tagNames[0])}`);
  await coverage.action('tag-view', 'manage', async () => {
    await page.getByTestId('tag-view-manage').click();
    await expect(page.getByTestId('stream-inbox-tags-page')).toBeVisible();
  });
  await graph('post', `flow_message/${messageId}/tags/${encodeURIComponent(created)}`);
  const beforeRename = (await message()).message_processing!.assignments[created];
  const renameRule = await graph<{ id: string }>('post', 'trigger', { name: `Rename contract ${Date.now()}`,
    trigger_type: 'tag', tag_pattern: 'stream_inbox.*.message.projected', enabled: true,
    message_tags: [created], then: { run_script: 'true' } });
  await coverage.action('tags', 'edit', async () => {
    await page.getByTestId(`stream-inbox-tag-row-${created}`).click();
    await expect(page.getByTestId('stream-inbox-tag-name')).toHaveValue(created);
  });
  await coverage.screen('tag-edit', page, info);
  await page.getByTestId('stream-inbox-tag-name').fill(successor);
  await coverage.action('tag-edit', 'save', async () => {
    await page.getByTestId('stream-inbox-tag-save').click();
    await expect(page.getByTestId(`stream-inbox-tag-row-${successor}`)).toBeVisible();
    await expect(page.getByTestId(`stream-inbox-tag-row-${created}`)).toHaveCount(0);
  });
  definitions = await graph('get', 'tag');
  expect(definitions.find((tag) => tag.name === created)).toMatchObject({ alias_of: successor, deprecated: true });
  const renamedMessage = await message();
  expect(renamedMessage.tags).toContain(successor);
  expect(renamedMessage.tags).not.toContain(created);
  expect(renamedMessage.message_processing!.assignments[successor]).toEqual(beforeRename);
  expect(await graph('get', `trigger/${renameRule.id}`)).toMatchObject({ message_tags: [successor] });
  await coverage.action('tags', 'delete', async () => {
    await page.getByTestId(`stream-inbox-tag-delete-${successor}`).click();
    await expect(page.getByTestId('stream-inbox-tag-delete-confirm')).toBeVisible();
  });
  await coverage.screen('tag-delete', page, info);
  await coverage.action('tag-delete', 'cancel', async () => {
    await page.getByTestId('stream-inbox-tag-delete-confirm').getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByTestId('stream-inbox-tag-delete-confirm')).toHaveCount(0);
    expect((await message()).tags).toContain(successor);
  });
  await page.getByTestId(`stream-inbox-tag-delete-${successor}`).click();
  await coverage.action('tag-delete', 'delete', async () => {
    await page.getByTestId('stream-inbox-tag-delete-confirm-confirm').click();
    await expect(page.getByTestId(`stream-inbox-tag-row-${successor}`)).toHaveCount(0);
  });
  const deletedMessage = await message();
  expect(deletedMessage.tags).not.toContain(successor);
  expect(deletedMessage.tags).toEqual(renamedMessage.tags.filter((name) => name !== successor));
  expect(await graph('get', `trigger/${renameRule.id}`)).toMatchObject({ enabled: false });
  expect(deletedMessage.text).toBe(body);
  await coverage.action('tags', 'flow', async () => {
    await page.getByTestId('message-classification-flow-tags').click();
    await expect(page.getByTestId('message-classification-flow-tags')).toHaveAttribute('data-state', 'checked');
  });
  expect(await graph('get', 'flow_message/classification-settings')).toMatchObject({ include_flow_tags: true });
  await page.reload();
  await expect(page.getByTestId('message-classification-flow-tags')).toHaveAttribute('data-state', 'checked');
});

const viewerNames: Record<string, string> = {
  'tag-view': tagNames[0], 'tag-view-today': tagNames[1], 'tag-view-action-required': tagNames[2],
  'tag-view-receipt': tagNames[3], 'tag-view-review': tagNames[4],
};
const removedNames: Record<string, string> = {
  'removed-refund': tagNames[0], relabelled: tagNames[1], 'removed-action-required': tagNames[2], 'removed-receipt': tagNames[3],
};
const queueScreens = ['queue', 'chained', 'once'];

test('stream_inbox details, picker controls and cancelled tag editors preserve URL state', async ({ page }) => {
  await graph('post', `flow_message/${messageId}/set-tags`, { tags: tagNames });
  await page.goto('/dock/stream_inbox');
  const row = streamInboxRow(page);
  await coverage.action('stream_inbox', 'details', async () => {
    await row.getByTestId('stream-inbox-message-tags').hover();
    await row.getByTestId('message-tags-menu').click();
    await expect(page.getByTestId('message-tags-picker')).toBeVisible();
    await expect(page).toHaveURL((url) => url.searchParams.get('message_tags') === `${messageId}:picker`);
  });
  await page.reload();
  await expect(page.getByTestId('message-tags-picker')).toBeVisible();
  await openMessage(page);
  await picker(page);
  await coverage.action('tag-picker', 'close', async () => {
    await page.getByTestId('message-tags-close').click();
    await expect(page.getByTestId('message-tags-picker')).toHaveCount(0);
    await expect(page).toHaveURL((url) => !url.searchParams.has('message_tags'));
  });
  await picker(page);
  await coverage.action('tag-picker', 'header-queue', async () => {
    await openQueue(page);
    await expect(page.getByTestId('message-tags-picker')).toHaveCount(0);
  });
  await page.reload();
  await expect(page.getByTestId('message-automation-queue-panel')).toBeVisible();
  await page.getByTestId('message-queue-close').click();
  await picker(page);
  await coverage.action('tag-picker', 'new', async () => {
    await page.getByTestId('message-tags-manage').click();
    await page.getByTestId(`stream-inbox-tag-add-${prefix}`).click();
    await expect(page.getByTestId('stream-inbox-tag-child-name')).toBeVisible();
    await expect(page).toHaveURL((url) => url.searchParams.get('adding') === prefix);
  });
  await page.getByTestId('stream-inbox-tag-child-name').fill('cancelled');
  await coverage.action('tag-create', 'cancel', async () => {
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByTestId('stream-inbox-tag-child-name')).toHaveCount(0);
    expect((await graph<Array<{ name: string }>>('get', 'tag')).some((tag) => tag.name === `${prefix}.cancelled`)).toBe(false);
  });
  await page.getByTestId(`stream-inbox-tag-row-${tagNames[0]}`).click();
  await page.getByTestId('stream-inbox-tag-name').fill(`${prefix}.cancelled-rename`);
  await coverage.action('tag-edit', 'cancel', async () => {
    await page.getByTestId('stream-inbox-tag-cancel').click();
    await expect(page.getByTestId('stream-inbox-tag-name')).toHaveValue(tagNames[0]);
    await expect(page.getByTestId(`stream-inbox-tag-row-${tagNames[0]}`)).toBeVisible();
  });
});

for (const [screen, index] of [['automation', 0], ['automation-test', 0], ['automation-today', 1], ['automation-review', 2]] as const) {
  test(`mock ${screen}: exact tag links and return after save`, async ({ page }, info) => {
    await graph('post', `flow_message/${messageId}/set-tags`, { tags: tagNames });
    const definition = approvedMock.screens.find((item) => item.id === screen)!;
    for (const action of definition.actions.filter((item) => viewerNames[item.to] || item.id === 'save')) {
      await openMessage(page);
      await tags(page).getByTestId('message-automation-queue').click();
      await page.getByTestId(`queue-entry-${rules[index].id}`).getByRole('button').first().click();
      await expect(page.getByTestId('message-rule-page')).toHaveAttribute('data-automation-id', rules[index].id);
      if (screen === 'automation-test') {
        await page.getByTestId('message-rule-fast-test-run').click();
        await expect(page.getByTestId('message-rule-fast-test-verdict')).toHaveAttribute('data-verdict', 'yes');
      }
      await coverage.action(screen, action.id, async () => {
        if (action.id === 'save') {
          const before = await graph('get', `trigger/${rules[index].id}`);
          await page.getByTestId('automation-save').click();
          await expect(page.getByTestId('message-automation-queue-panel')).toBeVisible();
          await expect(page).toHaveURL((url) => url.searchParams.get('message_tags') === `${messageId}:queue`);
          expect(await graph('get', `trigger/${rules[index].id}`)).toEqual(before);
        } else {
          const links = page.getByTestId(screen === 'automation-test' ? 'message-rule-preview-tags' : 'message-rule-origin-tags');
          await links.getByTitle(viewerNames[action.to], { exact: true }).click();
          await expect(page).toHaveURL((url) => decodeURIComponent(url.pathname) === `/dock/tag/graph/${viewerNames[action.to]}`);
          await expect(page.locator('.graph-view-root')).toBeVisible();
          await coverage.screen(action.to, page, info);
          if (action.to === 'tag-view-review') {
            await coverage.action('tag-view-review', 'back', async () => {
              await page.getByTestId('tag-view-back').click();
              await expect(page.getByTestId('message-tags-picker')).toBeVisible();
            });
          }
        }
      });
    }
  });
}

// The mock repeats header actions after edits and while a menu is open. Exercise
// EACH edge in its own source state; sharing a handler does not share evidence.
for (const screen of approvedMock.screens.filter((item) => [
  'message', 'relabelled', 'removed-refund', 'removed-action-required', 'removed-receipt', ...queueScreens,
].includes(item.id))) {
  const actions = screen.actions.filter((item) =>
    viewerNames[item.to] || removedNames[item.to] || ['tag-picker', 'queue', 'message', 'automation', 'automation-today', 'automation-review'].includes(item.to));
  for (let offset = 0; offset < actions.length; offset += 3) {
  test(`mock ${screen.id}: header and entity edges ${offset + 1}–${Math.min(offset + 3, actions.length)}`, async ({ page }, info) => {
    for (const action of actions.slice(offset, offset + 3)) {
      const initial = tagNames.filter((name) => name !== removedNames[screen.id]);
      await graph('post', `flow_message/${messageId}/set-tags`, { tags: initial });
      await openMessage(page);
      if (queueScreens.includes(screen.id)) {
        await openQueue(page);
      }
      await coverage.action(screen.id, action.id, async () => {
        if (viewerNames[action.to]) {
          await tags(page).locator(`[data-message-tag="${viewerNames[action.to]}"] button`).first().click();
          await expect(page).toHaveURL((url) => decodeURIComponent(url.pathname) === `/dock/tag/graph/${viewerNames[action.to]}`);
          await expect(page.locator('.graph-view-root')).toBeVisible();
          await coverage.screen(action.to, page, info);
        } else if (removedNames[action.to]) {
          await tags(page).getByTestId(`message-tag-remove-${removedNames[action.to]}`).click();
          await expect.poll(async () => (await message()).tags.includes(removedNames[action.to])).toBe(false);
          await expect(page.getByTestId(`message-bubble-${messageId}`)).toContainText(body);
        } else if (action.to === 'tag-picker') {
          if (queueScreens.includes(screen.id)) await page.keyboard.press('Escape');
          await picker(page);
        } else if (action.to === 'queue') {
          await openQueue(page);
        } else if (action.to === 'message') {
          await page.keyboard.press('Escape');
          await expect(page.getByTestId('message-automation-queue-panel')).toHaveCount(0);
        } else {
          const index = ['automation', 'automation-today', 'automation-review'].indexOf(action.to);
          await page.getByTestId(`queue-entry-${rules[index].id}`).getByRole('button').first().click();
          await expect(page).toHaveURL(new RegExp(`trigger=${rules[index].id}`));
        }
      });
    }
  });
  }
}

// eslint-disable-next-line no-empty-pattern
test('approved mock coverage is complete, with no silent skips', async ({}, info) => {
  await coverage.assertComplete(info);
  expect(diagnostics, 'browser errors need resolution, not suppression').toEqual([]);
});
