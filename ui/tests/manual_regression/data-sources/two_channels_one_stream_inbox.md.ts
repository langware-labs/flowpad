/**
 * Two channels, one stream inbox — see the sibling `.md`.
 *
 * Seeded the way the runbook seeds it: two `agent` sources owned by the local user
 * (`Support slack` over the slack connector, `Team mail` over gmail), 60 messages each
 * written through `POST /api/v1/ingest/items`, 20 per call — a call of 30+ is a BACKFILL
 * that projects only on the next poll's reconcile sweep, so 20 keeps every item announced
 * and projected now.
 *
 * "Nothing polls them": an `agent` source is ready on create (no `verify`), so the
 * heartbeat would launch a harness worker against the user's real connectors on its next
 * tick. Each row is born with `next_poll_at` far in the future — the poller's own
 * due-time gate (`DataSource.is_due`) — which keeps both rows `active` (the marks stay
 * "on") without a worker ever running.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { apiContext } from '../_shared/api';

const PER_SOURCE = 60;
const PER_CALL = 20;
const stamp = Date.now().toString(36);

let api: APIRequestContext;
let slackId = '';
let gmailId = '';

interface Item {
  external_id: string;
  name: string;
  body: string;
  author_display?: string;
}

async function graph<T = Record<string, unknown>>(method: 'get' | 'post' | 'delete', route: string, data?: unknown): Promise<T> {
  const res = await api[method](`/api/v1${route}`, data === undefined ? undefined : { data });
  const json = await res.json();
  expect(res.ok() && json.status === 'SUCCESS', `${method} ${route}: ${JSON.stringify(json).slice(0, 300)}`).toBeTruthy();
  return json.data as T;
}

async function createSource(name: string, connector: string, mailbox: string): Promise<string> {
  const row = await graph<{ id: string; status: string }>('post', '/graph/data_source', {
    name,
    provider: 'agent',
    config: { connector, mailbox },
    next_poll_at: '2099-01-01T00:00:00Z',
  });
  expect(row.status, `${name} is not listening`).toBe('active');
  return row.id;
}

/** 60 messages, oldest first, in calls of 20 so each is announced and projected. */
async function seed(sourceId: string, kind: string, make: (i: number, at: Date) => Record<string, unknown>) {
  // Recent enough to sit inside the source's window, one minute apart so "newest" is unambiguous.
  const base = Date.now() - 2 * 60 * 60 * 1000;
  for (let start = 0; start < PER_SOURCE; start += PER_CALL) {
    const items = Array.from({ length: PER_CALL }, (_, k) => {
      const i = start + k;
      return { data_source_id: sourceId, provider: 'agent', kind, ...make(i, new Date(base + i * 60_000)) };
    });
    const report = await graph<{ created: number; mode: string }>('post', '/ingest/items', { items });
    expect(report.mode, 'a seeding call ran as a backfill').toBe('incremental');
    expect(report.created).toBe(PER_CALL);
  }
}

const n3 = (i: number) => String(i).padStart(3, '0');

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  api = await apiContext();
  slackId = await createSource(`Support slack ${stamp}`, 'slack', 'C0123ABCD');
  gmailId = await createSource(`Team mail ${stamp}`, 'gmail', 'INBOX');
  // The connector's own kinds (`agent/source.py` profiles): only `content.message.*` is stream inbox material.
  await seed(slackId, 'content.message.chat', (i, at) => {
    // A Slack ts IS its event time; the envelope adopts it as `occurred_at`.
    const ts = `${Math.floor(at.getTime() / 1000)}.${n3(i)}100`;
    return { external_id: ts, thread_key: ts, name: '', body: `slack message ${n3(i)}`, author_display: 'Bob', author_external_id: 'U0BOB0001' };
  });
  await seed(gmailId, 'content.message.email', (i, at) => ({
    external_id: `<mail-${stamp}-${n3(i)}@example.test>`,
    thread_key: `mail-thread-${stamp}-${n3(i)}`,
    name: `Subject ${i}`,
    body: `mail body ${n3(i)}`,
    author_display: 'Alice',
    author_external_id: 'alice@example.test',
    occurred_at: at.toISOString(),
  }));
});

test.afterAll(async () => {
  for (const id of [slackId, gmailId]) if (id) await api.delete(`/api/v1/graph/data_source/${id}`);
  await api.dispose();
});

async function openStreamInbox(page: Page) {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('llm-setup-modal-seen', 'true');
    } catch {
      /* sandboxed frame */
    }
  });
  await page.goto('/dock/stream_inbox');
}

test('1. the API pages a source\'s items 50 at a time', async () => {
  const slack = await graph<{ items: Item[] }>('post', `/graph/data_source/${slackId}/items`, { limit: 50 });
  expect(slack.items).toHaveLength(50);
  expect(slack.items.map((it) => it.body)).toEqual(
    Array.from({ length: 50 }, (_, k) => `slack message ${n3(PER_SOURCE - 1 - k)}`),
  );
  const gmail = await graph<{ items: Item[] }>('post', `/graph/data_source/${gmailId}/items`, { limit: 50 });
  expect(gmail.items, '50 of 60').toHaveLength(50);
  expect(gmail.items.map((it) => it.name)).toEqual(Array.from({ length: 50 }, (_, k) => `Subject ${PER_SOURCE - 1 - k}`));
});

/** Every seeded message placed in its conversation. The projection lane places them one by
 *  one after the ingest returns; sampled, never hurried — the test's own timeout is the bound. */
async function projected() {
  await expect(async () => {
    const convs = await graph<Array<{ channel_source_id?: string; message_count?: number }>>('get', '/graph/conversation?limit=1000');
    const ours = convs.filter((c) => [slackId, gmailId].includes(c.channel_source_id ?? '') && (c.message_count ?? 0) > 0);
    expect(ours).toHaveLength(2 * PER_SOURCE);
  }).toPass();
}

test('2. the stream inbox merges both sources, attributed', async ({ page }) => {
  await projected();
  await openStreamInbox(page);
  await expect(page.getByTestId('stream-inbox-view-all')).toContainText(String(2 * PER_SOURCE));

  const bar = page.getByTestId('attached-channels');
  const marks = bar.getByTestId('attached-channel');
  await expect(marks).toHaveCount(2);
  for (const mark of await marks.all()) {
    await expect(mark).toHaveAttribute('data-provider', 'agent');
    await expect(mark).toHaveAttribute('data-state', 'on');
  }
  // A Gmail glyph and a Slack glyph — the transport's per-channel icons, so the two marks differ.
  // The glyph is the mark's first child (an inline svg or a served image); its markup minus
  // sizing classes is what it draws.
  const glyphs = await marks.evaluateAll((els) =>
    els.map((el) => (el.firstElementChild?.outerHTML ?? '').replace(/\sclass="[^"]*"/g, '')),
  );
  expect(glyphs[0], 'a mark drew no glyph').toBeTruthy();
  expect(glyphs[0], 'the two channels wear the same glyph').not.toBe(glyphs[1]);

  const rows = page.getByTestId('stream-inbox-conversation-row');
  await expect(rows).toHaveCount(2 * PER_SOURCE);
  await expect(rows.filter({ hasText: 'slack message' }).first()).toBeVisible();
  await expect(rows.filter({ hasText: /Subject \d+/ }).first()).toBeVisible();
  // Every row wears ITS source's chip.
  expect(await rows.locator('[data-chip-type="source"]').count()).toBe(2 * PER_SOURCE);
});

test('3. a mark narrows to ONE source; × restores', async ({ page }) => {
  await openStreamInbox(page);
  const bar = page.getByTestId('attached-channels');
  const rows = page.getByTestId('stream-inbox-conversation-row');
  await expect(rows).toHaveCount(2 * PER_SOURCE);

  const slackMark = bar.locator('[data-testid="attached-channel"][aria-label*="Support slack"]');
  await expect(slackMark).toHaveCount(1);
  const mailMark = bar.locator('[data-testid="attached-channel"][aria-label*="Team mail"]');
  await slackMark.click();
  await expect(slackMark).toHaveAttribute('aria-pressed', 'true');
  await expect(mailMark).toHaveAttribute('aria-pressed', 'false');
  // The other mark dims (the bar greys every unpressed glyph while filtering).
  await expect(mailMark.locator(':scope > :first-child')).toHaveCSS('filter', /grayscale/);
  await expect(slackMark.locator(':scope > :first-child')).toHaveCSS('filter', 'none');
  await expect(bar.getByTestId('attached-channels-clear')).toBeVisible();

  await expect(rows).toHaveCount(PER_SOURCE);
  for (const chip of await rows.locator('[data-chip-type="source"]').all()) await expect(chip).toHaveText('Slack');
  for (const sender of await rows.getByTestId('stream-inbox-row-sender').all()) await expect(sender).toHaveText('Bob');
  await expect(rows.filter({ hasText: /Subject \d+/ })).toHaveCount(0);

  await bar.getByTestId('attached-channels-clear').click();
  await expect(rows).toHaveCount(2 * PER_SOURCE);
  await expect(slackMark).toHaveAttribute('aria-pressed', 'false');
  await expect(mailMark).toHaveAttribute('aria-pressed', 'false');
});
