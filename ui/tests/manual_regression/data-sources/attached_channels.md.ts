/**
 * Attached channels — one bar, two owners. The runbook is the sibling `.md`.
 *
 * The user's ONE Slack source talks to the slack driver's own loopback Double, hosted by
 * `tests/e2e/channel_doubles.py` (spawned here under the instance's FLOW_INSTANCE, which also
 * plants the Slack connection the source resolves its token from) — so Verify, the poll and the
 * projected rows are the real code paths against a stand-in workspace. The agent's source is
 * added through the bar's own + and never verified, which is what parks it on "!".
 */
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { REPO_ROOT, apiContext, apiOrigin, configuredFileEnv } from '../_shared/api';

const INSTANCE = process.env.FLOW_INSTANCE || '';
const stamp = Date.now().toString(36);
const USER_SOURCE = `Team slack ${stamp}`;
const AGENT_SOURCE = `Agent slack ${stamp}`;
/** A channel id the double does not host — the agent's row is its own, never the user's adopted. */
const AGENT_CHANNEL = 'C0AGENT0001';

let api: APIRequestContext;
let doubles: ChildProcessWithoutNullStreams | undefined;
let control = '';
let localUserId = '';
let agentId = '';
let sourceId = '';
const nonces = [`one-${stamp}`, `two-${stamp}`];

interface SlackDouble {
  config: Record<string, unknown>;
  fields?: Record<string, unknown>;
}

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

const sourceStatus = async (id: string) => (await graph<{ status: string }>('get', `/graph/data_source/${id}`)).status;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  api = await apiContext();

  const users = await graph<Array<{ id: string; uname?: string }>>('get', '/graph/user');
  localUserId = users.find((u) => u.uname === 'local')?.id ?? '';
  expect(localUserId, 'no local user row').toBeTruthy();

  doubles = spawn('uv', ['run', 'python', 'tests/e2e/channel_doubles.py', '--backend', apiOrigin(), '--channels', 'slack'], {
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
  const slack = (await controlJson<Record<string, SlackDouble>>('GET', '/channels')).slack;
  expect(slack, 'the doubles host no slack').toBeTruthy();

  const agent = await graph<{ id: string }>('post', '/graph/agent', {
    name: `bar agent ${stamp}`,
    worker_type: 'claude',
    system_prompt: 'Be brief.',
  });
  agentId = agent.id;

  // The user's one message source: connected, verified, two messages in.
  const source = await graph<{ id: string }>('post', '/graph/data_source', {
    name: USER_SOURCE,
    provider: 'slack',
    config: slack.config,
    owner: `user-${localUserId}`,
    ...(slack.fields ?? {}),
  });
  sourceId = source.id;
  const verdict = await graph<{ ready: boolean; detail: string }>('post', `/graph/data_source/${sourceId}/verify`, {});
  expect(verdict.ready, verdict.detail).toBe(true);
  for (const nonce of nonces) await controlJson('POST', '/deliver', { channel: 'slack', text: `hello ${nonce}` });
  const report = await graph<{ health?: string; error_detail?: string }>('post', `/graph/data_source/${sourceId}/sync`, {});
  expect(report.health, `sync: ${report.error_detail ?? ''}`).toBe('ok');
});

test.afterAll(async () => {
  const rows = ((await (await api.get('/api/v1/graph/data_source')).json()).data ?? []) as Array<{ id: string; name: string }>;
  for (const row of rows.filter((r) => r.id === sourceId || r.name === AGENT_SOURCE)) {
    await api.delete(`/api/v1/graph/data_source/${row.id}`);
  }
  if (agentId) await api.delete(`/api/v1/graph/agent/${agentId}`);
  // `/shutdown` makes the doubles remove the connection they planted; wait for it to finish.
  if (doubles && control) {
    const exited = new Promise<void>((resolve) => doubles!.once('exit', () => resolve()));
    await api.post(`${control}/shutdown`).catch(() => undefined);
    await exited;
  }
  doubles?.kill();
  await api.dispose();
});

async function open(page: Page, route: string) {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('llm-setup-modal-seen', 'true');
    } catch {
      /* sandboxed frame */
    }
  });
  await page.goto(route);
}

/** What a glyph draws: the element's first child (an svg, or a brand mark's img/span) minus sizing. */
const glyphOf = (el: Locator) =>
  el.evaluate((node) => (node.firstElementChild?.outerHTML ?? '').replace(/\sclass="[^"]*"/g, ''));

/** The user's stream inbox, with both delivered messages listed. */
async function userStreamInbox(page: Page) {
  await open(page, '/dock/stream_inbox');
  const rows = page.getByTestId('stream-inbox-conversation-row');
  for (const nonce of nonces) await expect(rows.filter({ hasText: nonce })).toHaveCount(1);
  return { bar: page.getByTestId('attached-channels'), rows };
}

test('1. the header line shows the user\'s channels as round marks', async ({ page }) => {
  const { bar, rows } = await userStreamInbox(page);
  const line = page.getByTestId('stream-inbox-select-all-row');
  await expect(line.getByTestId('attached-channels')).toHaveAttribute('data-owner', /^user-/);

  const marks = bar.getByTestId('attached-channel');
  await expect(marks).toHaveCount(1);
  const mark = marks.first();
  await expect(mark).toHaveAttribute('data-provider', 'slack');
  await expect(mark).toHaveAttribute('data-state', 'on');
  await expect(bar.getByTestId('attached-channels-add')).toBeVisible();
  await expect(bar.getByTestId('attached-channels-details')).toBeVisible();

  // The coloured Slack mark: undimmed, and the very glyph every row's source chip wears.
  await expect(mark.locator(':scope > :first-child')).toHaveCSS('filter', 'none');
  const glyph = await glyphOf(mark);
  expect(glyph, 'the mark drew no glyph').toBeTruthy();
  const chips = rows.locator('[data-chip-type="source"]');
  await expect(chips).toHaveCount(await rows.count());
  for (const chip of await chips.all()) expect(await glyphOf(chip)).toBe(glyph);
});

test('2. a mark filters; × shows everything again', async ({ page }) => {
  const { bar, rows } = await userStreamInbox(page);
  const all = await rows.count();
  const mark = bar.getByTestId('attached-channel');
  const others = bar.locator('[data-testid="attached-channel"][aria-pressed="false"]');

  await mark.click();
  await expect(mark).toHaveAttribute('aria-pressed', 'true');
  await expect(mark).toHaveClass(/ring-1/);
  for (const other of await others.all()) await expect(other.locator(':scope > :first-child')).toHaveCSS('filter', /grayscale/);
  await expect(bar.getByTestId('attached-channels-clear')).toBeVisible();
  await expect(bar.getByTestId('attached-channels-add')).toHaveCount(0);
  await expect(bar.getByTestId('attached-channels-details')).toHaveCount(0);
  // Only rows whose latest message came through that source: both of ours, each wearing its chip.
  for (const nonce of nonces) await expect(rows.filter({ hasText: nonce })).toHaveCount(1);
  const chipped = rows.filter({ has: page.locator('[data-chip-type="source"]') });
  await expect(rows).toHaveCount(await chipped.count());

  await bar.getByTestId('attached-channels-clear').click();
  await expect(rows).toHaveCount(all);
  await expect(mark).toHaveAttribute('aria-pressed', 'false');
  await expect(bar.getByTestId('attached-channels-add')).toBeVisible();
  await expect(bar.getByTestId('attached-channels-details')).toBeVisible();
});

test('3. the details popover is where on/off and delete live', async ({ page }) => {
  const { bar } = await userStreamInbox(page);
  const mark = bar.getByTestId('attached-channel');

  await bar.getByTestId('attached-channels-details').click();
  const list = page.getByRole('dialog').filter({ has: page.getByTestId('attached-channel-row') });
  const row = list.getByTestId('attached-channel-row');
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId('attached-channel-switch')).toBeVisible();
  await expect(row.getByTestId('attached-channel-delete')).toBeVisible();

  // Off: the ring turns dashed, and the row is disabled.
  await row.getByTestId('attached-channel-switch').click();
  await expect(mark).toHaveAttribute('data-state', 'off');
  await expect(mark).toHaveClass(/border-dashed/);
  await expect.poll(() => sourceStatus(sourceId)).toBe('disabled');

  // On: a toast, and Slack owes a Verify — the "!" badge with the step under the name.
  await row.getByTestId('attached-channel-switch').click();
  await expect(
    page.locator('section[aria-label^="Notifications"] [data-sonner-toast]').filter({ hasText: 'Resumed — it polls on the next tick.' }),
  ).toBeVisible();
  await expect.poll(() => sourceStatus(sourceId)).toBe('setup');
  await expect(mark).toHaveAttribute('data-state', 'parked');
  await expect(mark).toContainText('!');
  await expect(row.getByTestId('attached-channel-verify')).toHaveText('Finish setup, then press Verify.');

  // The Data Sources screen, from the (still open) list's footer; Verify there.
  await list.getByTestId('attached-channels-see-all').click();
  await expect(page.getByTestId('data-sources-view')).toBeVisible();
  const card = page.locator('[data-testid="source-card"][data-provider="slack"]').filter({ hasText: USER_SOURCE });
  await card.getByTestId(`source-verify-${sourceId}`).click();
  await expect(card).toHaveAttribute('data-status', 'active');

  // Back on the stream inbox, the mark has its green dot.
  const back = await userStreamInbox(page);
  await expect(back.bar.getByTestId('attached-channel')).toHaveAttribute('data-state', 'on');

  // The trash asks first — cancel keeps the source.
  await back.bar.getByTestId('attached-channels-details').click();
  await page.getByTestId('attached-channel-row').getByTestId('attached-channel-delete').click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toContainText('Delete this data source?');
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toHaveCount(0);
  expect(await sourceStatus(sourceId)).toBe('active');
});

test('4. an agent\'s bar is its own', async ({ page }) => {
  await open(page, `/dock/agent/${agentId}/stream_inbox`);
  await expect(page.getByTestId('agent-stream-inbox-view')).toBeVisible();
  const agentBar = page.getByTestId('attached-channels');
  await expect(agentBar).toHaveAttribute('data-owner', `agent-${agentId}`);
  await expect(agentBar.getByTestId('attached-channel'), "a mark of the user's on the agent's line").toHaveCount(0);

  await agentBar.getByTestId('attached-channels-add').click();
  const dialog = page.getByRole('dialog').filter({ hasText: 'Add a data source' });
  await expect(dialog).toBeVisible();
  // Slack is a group (Flow — no setup / your own Slack app): the tile asks which, then the member opens its form.
  await dialog.getByTestId('provider-group-Slack').click();
  await dialog.getByTestId('group-member-slack').click();
  await dialog.locator('#ds-name').fill(AGENT_SOURCE);
  // `channel` is a picker that lists on open; asked of a workspace it cannot read, it hands the
  // field back to typing — where the id is pasted.
  const picker = dialog.getByTestId('ds-choice-channel');
  if (await picker.isVisible().catch(() => false)) {
    await picker.click();
    await expect(dialog.getByTestId('ds-choice-detail-channel')).toBeVisible();
  }
  await dialog.locator('#ds-channel').fill(AGENT_CHANNEL);
  await dialog.getByRole('button', { name: 'Add source' }).click();
  await expect(dialog).toBeHidden();

  // The stream inbox header line: the agent's own mark, parked on its Verify.
  const line = page.getByTestId('stream-inbox-select-all-row');
  const bar = line.getByTestId('attached-channels');
  await expect(bar).toHaveAttribute('data-owner', `agent-${agentId}`);
  const marks = bar.getByTestId('attached-channel');
  await expect(marks).toHaveCount(1);
  await expect(marks.first()).toHaveAttribute('aria-label', new RegExp(`^${AGENT_SOURCE}`));
  await expect(marks.first()).toHaveAttribute('data-state', 'parked');
  await expect(marks.first()).toContainText('!');
  // The list renders — not the "no channel" empty state.
  await expect(page.getByTestId('agent-stream-inbox-view')).not.toContainText('No channel reaches this Agent yet');

  // The user's bar shows only the user's source.
  const user = await userStreamInbox(page);
  const userMarks = user.bar.getByTestId('attached-channel');
  await expect(userMarks).toHaveCount(1);
  await expect(userMarks.first()).toHaveAttribute('aria-label', new RegExp(`^${USER_SOURCE}`));
});
