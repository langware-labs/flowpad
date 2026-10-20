/**
 * Inbound routing, end to end — every route is configured in the Inbound screen, then proven by a person writing
 * on WhatsApp and the agent's own reply coming back on WhatsApp.
 *
 *   waha stack (Meta's Cloud API in front of a fake WAHA) ──signed webhook──► hub chain ──► this desktop's channel
 *   ──► agent A / B / C (each answers "AGENT-<name>: <words>") ──Graph /messages──► waha stack (recorded)
 *
 * Preconditions (outside the test — a disposable instance, never the user's):
 *   scripts/instance_ctl.sh launch inbound-1                       # desk 5007 / backend 6007, signed in to the local hub
 *   <waha-service>/.venv/bin/python ui/tests/e2e/inbound-routing/waha_stack.py <waha-service> 7391
 *   curl -XPOST 127.0.0.1:7391/ctl/group -d '{"chat":"120363000000000001@g.us"}'   # the number's group
 *   FLOW_INSTANCE=inbound-1 uv run python ui/tests/e2e/inbound-routing/seed.py --backend http://localhost:6007 \
 *     --control http://127.0.0.1:7391 --group <group_id> > /tmp/inbound-seed.json
 * Run:
 *   cd ui && INB_SEED=/tmp/inbound-seed.json npx playwright test --config tests/e2e/inbound-routing/playwright.config.ts
 *
 * | # | configured in the UI                         | a person writes             | reply                     |
 * |---|----------------------------------------------|-----------------------------|---------------------------|
 * | 1 | the number, fallback → A                     | X, one to one               | AGENT-A to X              |
 * | 2 | + sender rule S → B                          | S, one to one               | AGENT-B to S              |
 * | 3 | + group rule G → C                           | T, in G                     | AGENT-C into G            |
 * | 4 | (nothing new: sender beats group)            | S, in G                     | AGENT-B into G            |
 * | 5 | S → A, group rule removed                    | S one to one; T in G        | AGENT-A to S; AGENT-A in G |
 */
import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';

const BE = `http://localhost:${process.env.INB_BE_PORT || '6007'}/api/v1/graph`;
const CTL = process.env.INB_CONTROL || 'http://127.0.0.1:7391';
const SEED = JSON.parse(readFileSync(process.env.INB_SEED || '/tmp/inbound-seed.json', 'utf8'));
const SHOTS = process.env.INB_SHOTS || '';
const X = '972500000201';
const S = '972500000202';
const T = '972500000203';
const GROUP_CHAT = '120363000000000001@g.us';
/** Every message carries this run's id: a reply from an earlier run can never pass for this one. */
const RUN = Date.now().toString(36);
const say = (what: string) => `${what} ${RUN}`;

const src = (name: 'A' | 'B' | 'C') => SEED.agents[name].source_id as string;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose JSON from the stack and the backend
async function json(url: string, init?: RequestInit): Promise<any> {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  return r.json();
}
const post = (url: string, body: unknown) =>
  json(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** A person writes on WhatsApp: one to one, or in the group. */
const write = (sender: string, text: string, group = '') => post(`${CTL}/ctl/inbound`, { sender, text, group });

/** The reply the number sent into `chat` carrying `text`, once an agent answered (or fail after the budget). */
async function replyIn(chat: string, text: string, budgetMs = 180_000): Promise<string> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const sent: { chat: string; text: string }[] = await json(`${CTL}/ctl/sent`);
    const hit = sent.find((s) => s.chat === chat && s.text.includes(text));
    if (hit) return hit.text;
    if (Date.now() > deadline) throw new Error(`no reply carrying "${text}" in ${chat}; sent: ${JSON.stringify(sent)}`);
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

async function openInbound(page: Page) {
  await page.goto('/dock/desk/inbound');
  await expect(page.getByTestId('inbound-view')).toBeVisible();
}

/** The number's card (there is exactly one in this run). */
const card = (page: Page) => page.locator('[data-testid^="inbound-number-"]').first();

async function addRule(page: Page, kind: 'user' | 'group', key: string, to: 'A' | 'B' | 'C') {
  await card(page).getByTestId('inbound-add-rule').click();
  const dialog = page.getByTestId('inbound-rule-dialog');
  await dialog.getByTestId(`inbound-rule-kind-${kind}`).click();
  await dialog.getByTestId('inbound-field-rule-key').fill(key);
  await dialog.getByTestId(`inbound-dest-this-${src(to)}`).click();
  await dialog.getByTestId('inbound-rule-save').click();
  await expect(dialog).toBeHidden();
}

test.describe.serial('inbound routing: waha → UI-configured chain → agent → reply', () => {
  let page: Page;
  let cfg: Record<string, string>;
  let group = '';

  test.beforeAll(async ({ browser }) => {
    cfg = await json(`${CTL}/ctl/config`);
    group = (await post(`${CTL}/ctl/group`, { chat: GROUP_CHAT, people: [S, T] })).group_id;
    // A clean slate: no claim left on this number from an earlier run.
    const mine = await json(`${BE}/data_source/inbound/mine`);
    for (const w of mine.data?.webhooks ?? []) {
      if (w.claim?.kind === 'account' && w.claim?.key === cfg.phone_number_id)
        await fetch(`${BE}/data_source/inbound/${w.id}`, { method: 'DELETE' });
    }
    page = await browser.newPage();
  });

  test('setup: connect the number through the UI, fallback → A', async () => {
    await openInbound(page);
    await page.getByTestId('inbound-connect').click();
    const dialog = page.getByTestId('inbound-connect-dialog');
    await dialog.getByTestId('inbound-choice-generic').click();
    for (const [id, value] of [
      ['inbound-field-phone-id', cfg.phone_number_id],
      ['inbound-field-token', cfg.token],
      ['inbound-field-graph-url', cfg.graph_url],
      ['inbound-field-app-secret', cfg.app_secret],
      ['inbound-field-verify-token', cfg.verify_token],
    ] as const) {
      const field = dialog.getByTestId(id);
      const input = (await field.evaluate((el) => el.tagName)) === 'INPUT' ? field : field.locator('input');
      await input.fill(value);
    }
    await dialog.getByTestId(`inbound-dest-this-${src('A')}`).click();
    await shot(page, '0-connect-form');
    await dialog.getByTestId('inbound-connect-submit').click();
    await expect(dialog.getByTestId('inbound-connected-step')).toBeVisible({ timeout: 60_000 });
    const url = (await dialog.getByTestId('inbound-connected-url').innerText()).trim();
    await shot(page, '0-connected');
    // "Paste these into your server's webhook settings" — the server side of the step.
    const configured = await json(`${cfg.graph_url}/${cfg.phone_number_id}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        webhook_configuration: JSON.stringify({ override_callback_uri: url, verify_token: cfg.verify_token }),
      }),
    });
    expect(configured.success, JSON.stringify(configured)).toBe(true);
    await dialog.getByTestId('inbound-connect-done').click();
    await expect(card(page)).toBeVisible();
  });

  test('1 — an unknown sender goes to the fallback: AGENT-A', async () => {
    await openInbound(page);
    const counter = card(page).locator('[data-testid^="inbound-counter-"]').first();
    await expect(counter).toBeVisible();
    const before = await counter.innerText();
    await write(X, say('scenario one'));
    expect(await replyIn(`${X}@c.us`, say('scenario one'))).toContain('AGENT-A');
    // The live counter moves while the page is open (read from the hub's recent deliveries, never stored).
    await expect(counter).not.toHaveText(before, { timeout: 30_000 });
    await expect(card(page).getByTestId('inbound-rule-row-fallback')).toBeVisible();
    await shot(page, '1-fallback');
  });

  test('2 — a sender rule S → B', async () => {
    await openInbound(page);
    await addRule(page, 'user', S, 'B');
    await expect(card(page).getByTestId(`inbound-rule-row-${S}`)).toBeVisible();
    await write(S, say('scenario two'));
    expect(await replyIn(`${S}@c.us`, say('scenario two'))).toContain('AGENT-B');
    await shot(page, '2-sender-rule');
  });

  test('3 — a group rule G → C', async () => {
    await openInbound(page);
    await addRule(page, 'group', group, 'C');
    await expect(card(page).getByTestId(`inbound-rule-row-${group}`)).toBeVisible();
    await write(T, say('scenario three'), GROUP_CHAT);
    expect(await replyIn(GROUP_CHAT, say('scenario three'))).toContain('AGENT-C');
    await shot(page, '3-group-rule');
  });

  test('4 — the sender rule beats the group rule: S in G → AGENT-B', async () => {
    await write(S, say('scenario four'), GROUP_CHAT);
    expect(await replyIn(GROUP_CHAT, say('scenario four'))).toContain('AGENT-B');
  });

  test('5 — S moved to A and the group rule removed: both reach A', async () => {
    await openInbound(page);
    const row = card(page).getByTestId(`inbound-rule-row-${S}`);
    await row.getByTestId('inbound-rule-edit').click();
    const dialog = page.getByTestId('inbound-rule-dialog');
    await dialog.getByTestId(`inbound-dest-this-${src('A')}`).click();
    await dialog.getByTestId('inbound-rule-save').click();
    await expect(dialog).toBeHidden();
    await card(page).getByTestId(`inbound-rule-row-${group}`).getByTestId('inbound-rule-remove').click();
    await page.getByTestId('inbound-remove-confirm').getByRole('button', { name: 'Remove' }).click();
    await expect(card(page).getByTestId(`inbound-rule-row-${group}`)).toHaveCount(0);
    await write(S, say('scenario five one'));
    expect(await replyIn(`${S}@c.us`, say('scenario five one'))).toContain('AGENT-A');
    await write(T, say('scenario five two'), GROUP_CHAT);
    expect(await replyIn(GROUP_CHAT, say('scenario five two'))).toContain('AGENT-A');
    await card(page).getByTestId('inbound-check-route').click();
    const check = page.getByTestId('inbound-route-check');
    await expect(check).toBeVisible();
    await expect(check.locator('[data-testid^="inbound-route-offline-"]')).toHaveCount(0);
    await expect(check.locator('[data-testid^="inbound-route-misroute-"]')).toHaveCount(0);
    await shot(page, '5-final');
  });
});
