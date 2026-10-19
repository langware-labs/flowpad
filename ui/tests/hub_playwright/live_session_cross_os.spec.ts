/**
 * Live session across operating systems — every edge case, one direction per run.
 *
 * ALICE is the GUEST (types prompts), BOB the HOST (runs them in its Claude Code).
 * Run twice: Mac guest → Windows host, and Windows guest → Mac host. Every case
 * screenshots both sides and judges from the backends' rows, never the screen.
 *
 *   ALICE_UI_URL / ALICE_BACKEND_URL, BOB_UI_URL / BOB_BACKEND_URL, BOB_CLOUD_EMAIL,
 *   GUEST_RESTART / HOST_RESTART  — shell scripts that restart that backend and
 *                                   return once it serves and is cloud-logged-in,
 *   CROSSOS_SHOTS                  — screenshot folder,
 *   HOST_BAD_WORKDIR               — a folder the host cannot run in (forces a failed turn).
 *
 * Real workers on both machines; the spec carries its own budget.
 */
import { execSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';

import { ALICE, BOB, gotoConversation, openInstance, startConversationViaUi } from './helpers';
import { BOB_EMAIL } from './_live_session_setup';

const SHOTS = process.env.CROSSOS_SHOTS || '/tmp';
const GUEST_RESTART = process.env.GUEST_RESTART || '';
const HOST_RESTART = process.env.HOST_RESTART || '';
const BAD_WORKDIR = process.env.HOST_BAD_WORKDIR || '/nonexistent/live-session-scratch';
const T = Date.now() % 100000;
const tok = (i: number | string) => `XO${i}-${T}`;
const ask = (i: number | string) => `Reply with exactly this word and nothing else: ${tok(i)}`;
const TURN_BUDGET = 240_000;

type Row = Record<string, unknown>;
const get = async (url: string) => ((await (await fetch(url)).json()) as { data: Row[] }).data;
const sessionsOn = async (backend: string, convId: string) =>
  (await get(`${backend}/api/v1/graph/remote_worker_session?limit=500`))
    .filter((r) => r.conversation_id === convId)
    .sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)));
const latest = async (backend: string, convId: string) => (await sessionsOn(backend, convId)).at(-1);
const guestMessages = async (convId: string) =>
  (await get(`${ALICE.backendUrl}/api/v1/graph/flow_message?limit=5000`)).filter((m) => m.conversation_id === convId);
const replies = async (convId: string) =>
  (await guestMessages(convId))
    .filter((m) => String(m.text ?? '').startsWith('Prompt response'))
    .map((m) => String(m.text));
const repliesFor = async (convId: string, t: string) => (await replies(convId)).filter((r) => r.includes(t));
const grantsOnHost = async () =>
  (await get(`${BOB.backendUrl}/api/v1/graph/contact_permission`)).filter((g) =>
    ((g.allowed_actions as string[]) ?? []).includes('auto_approve_session'),
  );

async function until<T>(
  what: string,
  probe: () => Promise<T | undefined | null | false>,
  ms = TURN_BUDGET,
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await probe().catch(() => undefined);
    if (v) return v as T;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function shot(page: Page, name: string) {
  await page.waitForTimeout(800); // let the line repaint before the picture
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
  console.log(`[shot] ${SHOTS}/${name}.png`);
}

async function both(alice: Page, bob: Page, convId: string, name: string) {
  await gotoConversation(alice, convId);
  await gotoConversation(bob, convId);
  await shot(alice, `${name}-guest`);
  await shot(bob, `${name}-host`);
}

async function openSession(alice: Page) {
  await alice.getByTestId('composer-session-toggle').click();
  await alice.waitForURL(/\/dock\/live_session\//, { timeout: 30_000 });
  await expect(alice.getByTestId('live-session-input')).toBeFocused({ timeout: 20_000 });
}

async function sendInView(alice: Page, text: string) {
  const box = alice.getByTestId('live-session-input');
  await box.fill(text);
  await box.press('Enter');
  await expect(box).toHaveValue('', { timeout: 20_000 });
}

function restart(script: string, who: string) {
  if (!script) throw new Error(`${who} restart script not set`);
  const t0 = Date.now();
  execSync(script, { stdio: 'inherit' });
  console.log(`[restart] ${who} back in ${Date.now() - t0} ms`);
}

test('live session cross-OS: every edge case', async ({ browser }) => {
  test.setTimeout(3_600_000);
  for (const g of await grantsOnHost())
    await fetch(`${BOB.backendUrl}/api/v1/graph/contact_permission/${g.id}`, { method: 'DELETE' });
  const alice = (await openInstance(browser, ALICE)).page;
  const bob = (await openInstance(browser, BOB)).page;
  const convId = await startConversationViaUi(alice, BOB_EMAIL, `cross-os-${T}`);
  await gotoConversation(alice, convId);
  await gotoConversation(bob, convId);

  // 01 — the icon opens the session view, cursor waiting, address conversation › Live session
  await openSession(alice);
  const crumbs = (await alice.locator('nav[aria-label="breadcrumb"]').first().innerText()).replace(/\s+/g, ' ');
  console.log('[01] address bar:', crumbs);
  expect(crumbs).toContain('Live session');
  await shot(alice, '01-icon-opens-session-view-guest');
  await until('host sees the request', async () => (await latest(BOB.backendUrl, convId))?.status === 'pending');
  await both(alice, bob, convId, '01-request-line');

  // 02 — Decline
  await expect(bob.getByTestId('session-card-decline').last()).toBeVisible({ timeout: 60_000 });
  await bob.getByTestId('session-card-decline').last().click();
  await until('declined on the guest', async () => (await latest(ALICE.backendUrl, convId))?.status === 'declined');
  await both(alice, bob, convId, '02-declined');

  // 03 — Approve once + Run (Skip project): per-instance temp folder, no grant
  await gotoConversation(alice, convId);
  await openSession(alice);
  await until('S2 on the host', async () => (await sessionsOn(BOB.backendUrl, convId)).length === 2);
  await gotoConversation(bob, convId);
  await bob.getByTestId('session-card-approve-once').last().click();
  await expect(bob.getByTestId('live-session-no-project')).toBeVisible({ timeout: 30_000 });
  await shot(bob, '03-approve-once-picker-host');
  await bob.getByTestId('live-session-no-project').click();
  const s2 = await until('S2 live with a temp folder', async () => {
    const r = await latest(BOB.backendUrl, convId);
    return r?.status === 'idle' && r.workdir ? r : null;
  });
  console.log('[03] host workdir:', s2.workdir);
  expect(String(s2.workdir)).toMatch(/live-session-scratch/);
  expect(await grantsOnHost()).toHaveLength(0);
  await until('guest sees S2 live', async () => (await latest(ALICE.backendUrl, convId))?.status === 'idle');
  await both(alice, bob, convId, '03-approved-once-live');

  // 04 — burst: 10 rapid follow-ups from the view + 3 prompts from the chat, all in the one session
  await gotoConversation(alice, convId);
  await alice.getByTestId('session-card').last().click();
  await alice.waitForURL(/\/dock\/live_session\//);
  for (let i = 1; i <= 10; i++) await sendInView(alice, ask(`b${i}`));
  await gotoConversation(alice, convId);
  for (let i = 11; i <= 13; i++)
    await (async () => {
      await alice.getByTestId('composer-session-toggle').click(); // opens the SAME open session
      await alice.waitForURL(/\/dock\/live_session\//);
      await sendInView(alice, ask(`b${i}`));
      await alice.goBack();
    })();
  await until(
    'all 13 burst replies',
    async () => {
      const r = await replies(convId);
      return Array.from({ length: 13 }, (_, i) => tok(`b${i + 1}`)).every((t) => r.some((x) => x.includes(t)));
    },
    900_000,
  );
  for (let i = 1; i <= 13; i++) expect(await repliesFor(convId, tok(`b${i}`)), `b${i} exactly once`).toHaveLength(1);
  expect(await sessionsOn(ALICE.backendUrl, convId)).toHaveLength(2); // no extra session minted
  await gotoConversation(alice, convId);
  await expect(alice.getByTestId('session-card')).toHaveCount(2);
  await both(alice, bob, convId, '04-burst-one-line');
  await alice.getByTestId('session-card').last().click();
  await alice.waitForURL(/\/dock\/live_session\//);
  // The view lists every burst reply, in send order (wait for them to render first).
  const burstReplies = alice.getByTestId('live-session-reply').filter({ hasText: /XOb\d+-/ });
  await expect(burstReplies).toHaveCount(13, { timeout: 60_000 });
  const order = (await burstReplies.allInnerTexts()).map((t) => Number(t.match(/XOb(\d+)-/)?.[1]));
  console.log('[04] reply order:', order.join(','));
  expect(order).toEqual(Array.from({ length: 13 }, (_, i) => i + 1));
  await shot(alice, '04-burst-session-view-guest');

  // 05 — unicode + long prompt, answered verbatim
  const uni = `שלום-עולם-✓-🚀-${T}`;
  const long = `${'Context line that must be ignored. '.repeat(110)}\nReply with exactly this text and nothing else: ${uni}`;
  await sendInView(alice, long);
  await until('unicode reply', async () => (await replies(convId)).some((r) => r.includes(uni)));
  await shot(alice, '05-unicode-long-guest');
  await both(alice, bob, convId, '05-unicode-long');

  // 06 — a file comes back from the host
  await gotoConversation(alice, convId);
  await alice.getByTestId('session-card').last().click();
  await alice.waitForURL(/\/dock\/live_session\//);
  const fname = `crossos-${T}.txt`;
  await sendInView(
    alice,
    `Create a text file named ${fname} containing the single line ${tok('file')} and attach it back to me with the flow conversation attach command from your instructions. Then reply DONE.`,
  );
  const fileMsg = await until(
    'the file reaches the guest',
    async () =>
      (await guestMessages(convId)).find((m) =>
        ((m.attachment as Row[]) ?? []).some(
          (a) => a.attachment_type === 'file' && String(a.data ?? '').includes(fname),
        ),
      ),
    600_000,
  );
  console.log('[06] file message:', fileMsg.id);
  await shot(alice, '06-file-back-guest');
  await both(alice, bob, convId, '06-file-back');

  // 07 — a failed prompt, then Retry: answered exactly once
  const fresh = (await latest(BOB.backendUrl, convId))!;
  const put = (workdir: unknown) =>
    fetch(`${BOB.backendUrl}/api/v1/graph/remote_worker_session/${String(s2.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...fresh, workdir }),
    });
  expect((await put(BAD_WORKDIR)).ok).toBe(true);
  await gotoConversation(alice, convId);
  await alice.getByTestId('session-card').last().click();
  await alice.waitForURL(/\/dock\/live_session\//);
  await sendInView(alice, ask('fail'));
  await until('the prompt fails on the host', async () => (await latest(BOB.backendUrl, convId))?.status === 'error');
  expect((await put(s2.workdir)).ok).toBe(true);
  await expect(alice.getByTestId('session-event-retry')).toBeVisible({ timeout: 60_000 });
  await shot(alice, '07-failed-retry-view-guest');
  await gotoConversation(alice, convId);
  await expect(alice.getByTestId('session-card-retry')).toBeVisible({ timeout: 60_000 });
  await both(alice, bob, convId, '07-failed-line');
  await alice.getByTestId('session-card-retry').click();
  await until('retried prompt answered', async () => (await repliesFor(convId, tok('fail'))).length > 0);
  expect(await repliesFor(convId, tok('fail'))).toHaveLength(1);
  await both(alice, bob, convId, '07-after-retry');

  // 08 — host backend restarts with prompts queued: each runs exactly once after
  await alice.getByTestId('session-card').last().click();
  await alice.waitForURL(/\/dock\/live_session\//);
  for (const k of ['h1', 'h2', 'h3']) await sendInView(alice, ask(k));
  restart(HOST_RESTART, 'host');
  await bob.reload();
  await until(
    'queued prompts answered after the host restart',
    async () => {
      const r = await replies(convId);
      return ['h1', 'h2', 'h3'].every((k) => r.some((x) => x.includes(tok(k))));
    },
    900_000,
  );
  for (const k of ['h1', 'h2', 'h3']) expect(await repliesFor(convId, tok(k)), `${k} once`).toHaveLength(1);
  await both(alice, bob, convId, '08-after-host-restart');

  // 09 — guest backend restarts mid-turn: the reply still lands on the guest
  await gotoConversation(alice, convId);
  await alice.getByTestId('session-card').last().click();
  await alice.waitForURL(/\/dock\/live_session\//);
  await sendInView(alice, ask('g1'));
  restart(GUEST_RESTART, 'guest');
  await alice.reload();
  await until(
    'the reply lands on the restarted guest',
    async () => (await repliesFor(convId, tok('g1'))).length > 0,
    900_000,
  );
  expect(await repliesFor(convId, tok('g1'))).toHaveLength(1);
  await both(alice, bob, convId, '09-after-guest-restart');

  // 10 — host Disconnect mid-turn: ended on both
  await alice.getByTestId('session-card').last().click();
  await alice.waitForURL(/\/dock\/live_session\//);
  await sendInView(alice, 'Count slowly from 1 to 30, one number per line, then reply END.');
  await until('the turn is running', async () => (await latest(BOB.backendUrl, convId))?.status === 'running', 120_000);
  await gotoConversation(bob, convId);
  await bob.getByTestId('session-card-disconnect').last().click();
  await until('ended on the guest', async () => (await latest(ALICE.backendUrl, convId))?.status === 'ended');
  await until('ended on the host', async () => (await latest(BOB.backendUrl, convId))?.status === 'ended');
  await both(alice, bob, convId, '10-host-disconnect-mid-turn');

  // 11 — Approve (remembers the guest) → the GUEST disconnects
  await gotoConversation(alice, convId);
  await openSession(alice);
  await until('S3 on the host', async () => (await sessionsOn(BOB.backendUrl, convId)).length === 3);
  await gotoConversation(bob, convId);
  await shot(bob, '11-request-host');
  await bob.getByTestId('session-card-approve').last().click();
  await bob.getByTestId('live-session-no-project').click();
  await until('S3 live', async () => (await latest(BOB.backendUrl, convId))?.status === 'idle');
  const grants = await grantsOnHost();
  expect(grants).toHaveLength(1);
  await until('guest sees S3 live', async () => (await latest(ALICE.backendUrl, convId))?.status === 'idle');
  await both(alice, bob, convId, '11-approved-remembered');
  await gotoConversation(alice, convId);
  await alice.getByTestId('session-card-disconnect').last().click();
  await until('S3 ended on the host', async () => (await latest(BOB.backendUrl, convId))?.status === 'ended');
  await both(alice, bob, convId, '11-guest-disconnected');

  // 12 — the remembered guest starts without asking, in the same temp folder
  await gotoConversation(alice, convId);
  await openSession(alice);
  const s4 = await until(
    'S4 approved with no host click',
    async () => {
      const r = await latest(BOB.backendUrl, convId);
      return r?.status === 'idle' && (await sessionsOn(BOB.backendUrl, convId)).length === 4 ? r : null;
    },
    120_000,
  );
  expect(s4.approved_via).toBe('standing_grant');
  expect(s4.workdir).toBe(s2.workdir);
  await sendInView(alice, ask('r1'));
  await until('remembered session answers', async () => (await repliesFor(convId, tok('r1'))).length > 0);
  await both(alice, bob, convId, '12-remembered-auto-start');

  for (const g of await grantsOnHost())
    await fetch(`${BOB.backendUrl}/api/v1/graph/contact_permission/${g.id}`, { method: 'DELETE' });
});
