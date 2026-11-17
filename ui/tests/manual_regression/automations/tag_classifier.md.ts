/** The approved tag-classifier mock, walked in a real browser on a disposable instance.
 * Backend: tests/e2e/mock_worker_backend.py with MOCK_DECISION=1 MOCK_DECISION_MATCH=1 — only the
 * Decision API is doubled (it picks the option whose meaning the message mentions most); HTTP, DB, bus
 * and the telegram arrival path are real. Run it with `bash scripts/test_message_tags_browser.sh tag_classifier`.
 *
 * Scenarios: the row cell (no tags / one / many), the quick menu (see, remove, tick), Edit tags… → the
 * editor with the message carried, add a sub-tag, Run, edit instructions → Rerun, Another message → Run, Apply.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { apiContext, apiOrigin, configuredFileEnv, REPO_ROOT } from '../_shared/api';
import { dismissSetupModal } from '../triggers/helpers';

type Message = { id: string; text: string; conversation_id?: string; tags: string[] };
const stamp = Date.now();
const TREE: Array<[string, string, string]> = [
  ['stream_inbox.support', '#3b82f6', 'Getting help with the product'],
  ['stream_inbox.support.billing', '#8b5cf6', 'Invoices, payment methods, plan changes'],
  ['stream_inbox.support.refund', '#f97316', 'Asks for money back'],
  ['stream_inbox.sales', '#22c55e', 'Buying, pricing, partnerships'],
  ['stream_inbox.sales.intro', '#14b8a6', 'An introduction call with someone new'],
  ['stream_inbox.urgent', '#e11d48', 'Needs an answer today'],
];
const TEXT = {
  many: `I was charged twice and I want my money back ${stamp}`,
  one: `Can we book an introduction call next week ${stamp}`,
  none: `Hello there ${stamp}`,
};
let api: APIRequestContext;
let doubles: ChildProcess;
let control = '';
let sourceId = '';
const arrived: Record<keyof typeof TEXT, Message> = {} as never;

async function graph<T = Record<string, unknown>>(method: 'get' | 'post' | 'delete', route: string, data?: unknown): Promise<T> {
  const response = await api[method](`/api/v1/graph/${route}`, data === undefined ? undefined : { data });
  const result = await response.json();
  expect(response.ok() && result.status === 'SUCCESS', `${method} ${route}: ${JSON.stringify(result)}`).toBe(true);
  return result.data as T;
}
const tagsOf = async (key: keyof typeof TEXT) => (await graph<Message>('get', `flow_message/${arrived[key].id}`)).tags;
const row = (page: Page, key: keyof typeof TEXT) =>
  page.locator(`[data-testid="stream-inbox-conversation-row"][data-conversation-id="${arrived[key].conversation_id}"]`);
const cell = (page: Page, key: keyof typeof TEXT) => row(page, key).getByTestId('message-tags-menu');
const picker = (page: Page) => page.getByTestId('message-tags-picker');

test.describe.configure({ mode: 'serial' });
test.use({ launchOptions: { args: ['--enable-unsafe-swiftshader'] } });

test.beforeAll(async () => {
  expect(process.env.FLOW_INSTANCE, 'set a disposable FLOW_INSTANCE').toMatch(/^tags-rig-/);
  api = await apiContext();
  // Arrivals are tagged here by hand, so the row states are exactly the mock's.
  await graph('post', 'flow_message/classification-settings', { enabled: false, include_flow_tags: false, root: 'inbox' });
  for (const [name, color, description] of TREE) await graph('post', 'tag', { name, color, description, stream_inbox: true });
  doubles = spawn('uv', ['run', 'python', 'tests/e2e/channel_doubles.py', '--backend', apiOrigin(), '--channels', 'telegram'], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...configuredFileEnv(), FLOWPAD_SKIP_DOTENV: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  control = await new Promise<string>((resolve, reject) => {
    let buffer = '';
    let errors = '';
    doubles.stderr!.on('data', (chunk) => (errors += String(chunk)));
    doubles.stdout!.on('data', (chunk) => {
      buffer += String(chunk);
      const line = buffer.split('\n').find((value) => value.includes('"control"'));
      if (line) resolve(JSON.parse(line).control);
    });
    doubles.on('exit', (code) => reject(new Error(`channel fixture exited ${code}: ${errors}`)));
  });
  const entry = (await (await api.get(`${control}/channels`)).json()).telegram;
  const source = await graph<{ id: string }>('post', 'data_source', {
    name: `Tag classifier ${stamp}`,
    provider: 'telegram',
    config: entry.config,
    inbound_allowed_senders: [],
    ...entry.fields,
    ...(entry.secret_store ? { secret_store: entry.secret_store } : {}),
  });
  sourceId = source.id;
  await graph('post', `data_source/${sourceId}/verify`, {});
  for (const [key, text] of Object.entries(TEXT) as Array<[keyof typeof TEXT, string]>) {
    expect((await api.post(`${control}/deliver`, { data: { channel: 'telegram', text, sender: `${key}-${stamp}` } })).ok()).toBe(true);
  }
  await graph('post', `data_source/${sourceId}/sync`, {});
  await expect
    .poll(async () => {
      const rows = await graph<Message[]>('get', 'flow_message');
      for (const key of Object.keys(TEXT) as Array<keyof typeof TEXT>) {
        const found = rows.find((item) => item.text === TEXT[key]);
        if (found) arrived[key] = found;
      }
      return Object.keys(arrived).length;
    })
    .toBe(3);
  await graph('post', `flow_message/${arrived.many.id}/set-tags`, { tags: ['stream_inbox.support.billing', 'stream_inbox.urgent', 'stream_inbox.sales'] });
  await graph('post', `flow_message/${arrived.one.id}/set-tags`, { tags: ['stream_inbox.support.billing'] });
});

test.beforeEach(async ({ page }) => {
  await dismissSetupModal(page);
});
test.afterAll(async () => {
  if (control) await api.post(`${control}/shutdown`);
  if (doubles && doubles.exitCode === null) doubles.kill('SIGTERM');
  await api?.dispose();
});

test('row cell: crossed tag when none, the chip when one, first + count when more', async ({ page }) => {
  await page.goto('/dock/stream_inbox');
  await expect(cell(page, 'none')).toHaveAttribute('aria-label', 'No tags — add one');
  await expect(cell(page, 'none')).toHaveText('');
  await expect(cell(page, 'one')).toHaveText('billing');
  await expect(cell(page, 'many')).toHaveText('billing+2');
  await expect(cell(page, 'one')).toHaveAttribute('style', /#8b5cf6|139, 92, 246/);
  expect((await row(page, 'many').boundingBox())!.height).toBe(36);
});

test('quick menu on many tags: see them, remove one with ✕, tick it back', async ({ page }) => {
  await page.goto('/dock/stream_inbox');
  await cell(page, 'many').click();
  await expect(picker(page)).toBeVisible();
  const box = await picker(page).boundingBox();
  expect(box!.x, 'the menu opens beside its row, not at the window corner').toBeGreaterThan(200);
  const selected = picker(page).getByTestId('message-picker-tags');
  await expect(selected.locator('[data-message-tag]')).toHaveCount(3);
  await selected.getByRole('button', { name: 'Remove tag stream_inbox.urgent', exact: true }).click();
  await expect.poll(() => tagsOf('many')).not.toContain('stream_inbox.urgent');
  await expect(picker(page).getByTestId('message-tag-option-inbox.urgent')).not.toBeChecked();
  await picker(page).getByTestId('message-tag-option-inbox.urgent').check();
  await expect.poll(() => tagsOf('many')).toContain('stream_inbox.urgent');
  await expect(selected.locator('[data-message-tag]')).toHaveCount(3);
  // Reload keeps the menu open: it lives in the URL.
  await page.reload();
  await expect(picker(page)).toBeVisible();
  await picker(page).getByTestId('message-tags-close').click();
  await expect(picker(page)).toHaveCount(0);
});

test('quick menu on no tags: says so, ticking tags the message, unticking clears it', async ({ page }) => {
  await page.goto('/dock/stream_inbox');
  await cell(page, 'none').click();
  await expect(picker(page)).toContainText('No tags yet');
  await picker(page).getByTestId('message-tag-option-inbox.sales.intro').check();
  await expect.poll(() => tagsOf('none')).toEqual(['stream_inbox.sales.intro']);
  await expect(cell(page, 'none')).toHaveText('intro');
  await picker(page).getByTestId('message-tag-option-inbox.sales.intro').uncheck();
  await expect.poll(() => tagsOf('none')).toEqual([]);
  await expect(cell(page, 'none')).toHaveAttribute('aria-label', 'No tags — add one');
});

test('Edit tags… opens the editor on this message; add a sub-tag; Run lands on the tree', async ({ page }) => {
  await page.goto('/dock/stream_inbox');
  await cell(page, 'many').click();
  await picker(page).getByTestId('message-tags-manage').click();
  await expect(page.getByTestId('stream-inbox-tags-page')).toBeVisible();
  await expect(page.getByTestId('stream-inbox-tag-try-message')).toContainText(`many-${stamp}`);

  await page.getByTestId('stream-inbox-tag-add-inbox.support').click();
  await page.getByTestId('stream-inbox-tag-child-name').fill('Chargeback');
  await expect(page.getByText('stream_inbox.support.chargeback')).toBeVisible();
  await page.getByTestId('stream-inbox-tag-child-save').click();
  await expect(page.getByTestId('stream-inbox-tag-row-inbox.support.chargeback')).toBeVisible();
  await expect(page).toHaveURL(/node=inbox\.support\.chargeback/);

  await page.getByTestId('stream-inbox-tag-try-run').click();
  await expect(page.getByTestId('stream-inbox-tag-try-landed')).toHaveText('stream_inbox.support.refund');
  await expect(page.getByTestId('stream-inbox-tag-row-inbox.support.refund').getByTestId('stream-inbox-tag-lands')).toBeVisible();
  await expect(page.getByTestId('stream-inbox-tag-try-current')).toContainText('billing');
  expect(await tagsOf('many'), 'Run is a dry run').not.toContain('stream_inbox.support.refund');
});

test('edit instructions marks the result stale; Rerun moves it and shows where it was', async ({ page }) => {
  await page.goto(`/dock/tag/graph?manage=stream_inbox&message=${arrived.many.id}&conversation=${arrived.many.conversation_id}`);
  await page.getByTestId('stream-inbox-tag-try-run').click();
  await expect(page.getByTestId('stream-inbox-tag-try-landed')).toHaveText('stream_inbox.support.refund');
  await page.getByTestId('stream-inbox-tag-row-inbox.support.billing').click();
  await page.getByTestId('stream-inbox-tag-swatch-#ef4444').click();
  await page.getByTestId('stream-inbox-tag-description').fill('Charged twice: they want the money back');
  await expect(page.getByTestId('stream-inbox-tag-unsaved')).toBeVisible();
  await expect(page.getByTestId('stream-inbox-tag-try-result')).toContainText('stale');
  await page.getByTestId('stream-inbox-tag-save').click();
  await expect(page.getByTestId('stream-inbox-tag-unsaved')).toHaveCount(0);
  await page.getByTestId('stream-inbox-tag-try-run').click();
  await expect(page.getByTestId('stream-inbox-tag-try-landed')).toHaveText('stream_inbox.support.billing');
  await expect(page.getByTestId('stream-inbox-tag-try-was')).toHaveText('was stream_inbox.support.refund');
  const saved = (await graph<Array<{ name: string; color: string }>>('get', 'tag')).find((tag) => tag.name === 'stream_inbox.support.billing');
  expect(saved?.color).toBe('#ef4444');
});

test('Another message → pick → Run; Apply tags the message', async ({ page }) => {
  await page.goto(`/dock/tag/graph?manage=stream_inbox&message=${arrived.many.id}&conversation=${arrived.many.conversation_id}`);
  await page.getByTestId('stream-inbox-tag-try-another').click();
  await page.getByTestId(`stream-inbox-tag-try-pick-${arrived.one.id}`).click();
  await expect(page.getByTestId('stream-inbox-tag-try-message')).toContainText(`one-${stamp}`);
  await page.getByTestId('stream-inbox-tag-try-run').click();
  await expect(page.getByTestId('stream-inbox-tag-try-landed')).toHaveText('stream_inbox.sales.intro');
  await page.getByTestId('stream-inbox-tag-try-apply').click();
  await expect.poll(() => tagsOf('one')).toContain('stream_inbox.sales.intro');
});
