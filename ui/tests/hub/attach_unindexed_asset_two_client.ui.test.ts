/**
 * Attaching an asset the list found on disk but nobody indexed yet -- through the REAL browser, across two
 * instances. The list is a read-only disk scan: it offers an id with no row, and a message used to refuse it
 * ("Cannot send: skill-… there is no local record of it"; a help-desk reply answered a bare 400). Picking it
 * now indexes it, so:
 *   1. a reply to a person carries it, and bob receives it;
 *   2. a reply in a help-desk ticket carries it;
 *   3. "New conversation" whose first message is still refused (the skill is gone by Create) leaves
 *      no empty conversation behind -- the person sees why, the recipients get nothing.
 *
 *   scripts/instance_ctl.sh launch dev-1 && scripts/instance_ctl.sh launch dev-2
 *   (cd ui && FLOWPAD_HUB_URL=http://localhost:8093 SHARE_INST_1=dev-1 SHARE_INST_2=dev-2 … npx vitest run --project hub attach_unindexed)
 * Skips otherwise. Do NOT raise a timeout here without explicit approval.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { hubAvailable } from './_hub';
import { pollUntil } from './_matrix';
import { HUB_INST_1 as INST_1, HUB_INST_2 as INST_2, getInstance, instanceAvailable, postApi, syncAssignedConversation, type ResolvedInstance } from './_instances';
import { launchBrowser, openInstancePage, type InstancePage } from './_browser';

let skipReason: string | null = null;
let alice: ResolvedInstance;
let bob: ResolvedInstance;
let browser: Browser;
let alicePage: InstancePage;
const token = randomUUID().slice(0, 8);

/** A skill in alice's own user scope that no indexer has seen: the list will offer it, the DB has no row. */
function unindexedSkill(label: string): { name: string; dir: string } {
  const name = `${label}-${token}`;
  const dir = path.join(os.homedir(), '.flow', 'instances', INST_1, 'home', '.claude', 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: never indexed ${token}\n---\nprobe\n`);
  return { name, dir };
}

/** The list shows only the scopes the viewer switched on: switch on the one alice's probes live in. */
async function showUserScope(page: Page): Promise<void> {
  // The narrowed list (server-side, debounced) brings its own scope toggles: wait for them.
  await page.getByTestId('asset-scope-toggle-user').waitFor({ state: 'visible', timeout: 15_000 });
  for (const scope of ['user', 'worker']) {
    const toggle = page.getByTestId(`asset-scope-toggle-${scope}`);
    if ((await toggle.count()) && (await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
  }
}

/** Open the asset picker on `page`, find `name`, and pick it. */
async function pick(page: Page, opener: string, name: string): Promise<void> {
  // The composer's attach actions live in its "More actions" (+) menu.
  await page.getByTestId('composer-more-actions').first().click();
  await page.getByTestId(opener).first().click();
  const filter = page.getByTestId('asset-manager-list-filter');
  await filter.waitFor({ state: 'visible', timeout: 10_000 });
  await filter.fill(name);
  await showUserScope(page);
  const row = page.locator('[data-testid^="asset-manager-row-"]').filter({ hasText: name });
  await row.waitFor({ state: 'visible', timeout: 15_000 }).catch(async (e) => {
    await page.screenshot({ path: path.join(os.tmpdir(), `attach-pick-fail-${token}.png`) });
    throw e;
  });
  await row.locator('[data-testid^="asset-manager-select-"]').click();
  await page.keyboard.press('Escape');
  // Picking indexes the asset first: the person sends once its chip is in the composer.
  await page
    .getByTestId('attach-menu-asset-list')
    .last()
    .getByText(name, { exact: true })
    .waitFor({ state: 'visible', timeout: 15_000 });
}

async function reply(page: Page, text: string): Promise<void> {
  const box = page.getByPlaceholder(/Reply to/).last();
  await box.click();
  await box.fill(text);
  await box.press('Enter');
}

async function aliceMessage(conversationId: string, text: string): Promise<any> {
  return pollUntil(
    async () => {
      const rows: any[] = ((await alice.sdk.FlowMessage.query(
        new alice.sdk.QueryRequest({ type: 'flow_message', query: { conversation_id: conversationId }, name: 'attach probe' }),
        true,
      ).catch(() => [])) ?? []) as any[];
      return rows.find((m) => (m.text ?? '').includes(text)) ?? null;
    },
    20_000,
    `alice's message "${text}"`,
  );
}

const skillRefs = (fm: any): string[] =>
  (fm.attachment ?? []).filter((a: any) => a.attachment_type === 'type_id' && String(a.data).startsWith('skill-')).map((a: any) => a.data);

beforeAll(async () => {
  const hub = await hubAvailable();
  if (!hub.ok) return void (skipReason = hub.reason ?? 'hub unreachable');
  if (!instanceAvailable(INST_1) || !instanceAvailable(INST_2)) {
    return void (skipReason = `launch ${INST_1} + ${INST_2} (with frontends) via scripts/instance_ctl.sh`);
  }
  alice = await getInstance(INST_1);
  bob = await getInstance(INST_2);
  browser = await launchBrowser();
  alicePage = await openInstancePage(browser, INST_1);
}, 60_000);

afterAll(async () => {
  await browser?.close().catch(() => undefined);
});

beforeEach((ctx: any) => {
  if (skipReason) {
    console.error(`[attach-unindexed] SKIP: ${skipReason}`);
    ctx.skip();
  }
});

describe('an asset nobody indexed yet, picked from the list', () => {
  it('a reply to a person carries it, and bob receives it', async () => {
    const skill = unindexedSkill('person-probe');
    const asked = await postApi(alice.apiUrl, '/graph/ask-for-help', {
      recipients: [{ kind: 'person', email: bob.email }],
      text: `attach probe ${token}`,
      diagnose: false,
      share_context: false,
    });
    const conversationId = asked?.data?.conversation_id;
    expect(conversationId, JSON.stringify(asked)).toBeTruthy();

    const { page } = alicePage;
    await page.goto(`${alicePage.feUrl}/dock/conversation/${conversationId}`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('composer-more-actions').first().waitFor({ state: 'visible', timeout: 25_000 });
    await pick(page, 'attach-asset-button', skill.name);
    await reply(page, `with the skill ${token}`);

    const sent = await aliceMessage(conversationId, `with the skill ${token}`);
    expect(await page.getByText(/no local record/).count(), 'the send was not refused').toBe(0);
    expect(skillRefs(sent), 'the skill rides on the message').toHaveLength(1);

    const received = await pollUntil(async () => {
      // A reply is the conversation's second message: bob pulls it the way his StreamInbox does.
      await syncAssignedConversation(bob, conversationId).catch(() => undefined);
      const fm: any = await bob.sdk.FlowMessage.getById(sent.id).catch(() => null);
      return fm && fm.body_status === 'ready' ? fm : null;
    }, 25_000, 'the reply READY on bob');
    expect(skillRefs(received)).toEqual(skillRefs(sent));
  }, 90_000);

  it('a reply in a help-desk ticket carries it (was: a bare 400)', async () => {
    const skill = unindexedSkill('desk-probe');
    const asked = await postApi(alice.apiUrl, '/graph/ask-for-help', {
      recipients: [{ kind: 'desk' }],
      text: `desk attach probe ${token}`,
      diagnose: false,
      share_context: false,
    });
    const conversationId = asked?.data?.conversation_id;
    expect(conversationId, JSON.stringify(asked)).toBeTruthy();

    const { page } = alicePage;
    await page.goto(`${alicePage.feUrl}/dock/conversation/${conversationId}`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('composer-more-actions').first().waitFor({ state: 'visible', timeout: 25_000 });
    await pick(page, 'attach-asset-button', skill.name);
    await reply(page, `desk with the skill ${token}`);

    const sent = await aliceMessage(conversationId, `desk with the skill ${token}`);
    expect(await page.getByText(/status code 400|no local record/).count(), 'the send was not refused').toBe(0);
    expect(skillRefs(sent)).toHaveLength(1);
    await pollUntil(async () => {
      const fm: any = await alice.sdk.FlowMessage.getById(sent.id).catch(() => null);
      return fm && ['sent', 'delivered', 'read'].includes(String(fm.delivery_status)) ? fm : null;
    }, 25_000, 'the desk reply reached the hub');
  }, 90_000);

  it('"New conversation" whose first message is refused leaves no empty conversation behind', async () => {
    const skill = unindexedSkill('gone-probe');
    const title = `nothing left behind ${token}`;
    const { page } = alicePage;
    await page.goto(`${alicePage.feUrl}/dock/stream_inbox`, { waitUntil: 'domcontentloaded' });
    const start = page.getByRole('button', { name: /new conversation/i }).first();
    await start.waitFor({ state: 'visible', timeout: 25_000 }).catch(async (e) => {
      await page.screenshot({ path: path.join(os.tmpdir(), `attach-newconv-fail-${token}.png`) });
      throw e;
    });
    await start.click();
    const dialog = page.getByTestId('new-conversation-dialog');
    await dialog.waitFor({ state: 'visible', timeout: 15_000 });
    await page.getByTestId('conversation-title-input').fill(title);
    const who = page.getByTestId('participant-input');
    await who.click();
    await who.pressSequentially(bob.email, { delay: 10 });
    await who.press('Enter');
    await page.getByTestId('initial-message-input').fill(`first message ${token}`);
    await dialog.getByRole('button', { name: 'Attach', exact: true }).click();
    await page.getByText('Asset', { exact: true }).last().click();
    const filter = page.getByTestId('asset-manager-list-filter');
    await filter.waitFor({ state: 'visible', timeout: 10_000 });
    await filter.fill(skill.name);
    await showUserScope(page);
    const row = page.locator('[data-testid^="asset-manager-row-"]').filter({ hasText: skill.name });
    await row.waitFor({ state: 'visible', timeout: 15_000 });
    await row.locator('[data-testid^="asset-manager-select-"]').click();
    await page.keyboard.press('Escape');
    await dialog
      .getByTestId('attach-menu-asset-list')
      .getByText(skill.name, { exact: true })
      .waitFor({ state: 'visible', timeout: 15_000 });
    // The skill disappears before Create -- its folder and its row -- so its first message cannot ship.
    rmSync(skill.dir, { recursive: true, force: true });
    const rows: any[] = ((await alice.sdk.Skill.query(
      new alice.sdk.QueryRequest({ type: 'skill', query: { name: skill.name }, name: 'gone skill' }),
      true,
    ).catch(() => [])) ?? []) as any[];
    for (const row of rows) await row.delete().catch(() => undefined);
    await dialog.getByRole('button', { name: 'Create' }).click();

    await page.getByText(/Cannot send/).first().waitFor({ state: 'visible', timeout: 20_000 }).catch(async (e) => {
      await page.screenshot({ path: path.join(os.tmpdir(), `attach-create-fail-${token}.png`) });
      throw e;
    });
    await page.waitForTimeout(1_500);
    const left: any[] = ((await alice.sdk.Conversation.query(
      new alice.sdk.QueryRequest({ type: 'conversation', query: { title }, name: 'left behind' }),
      true,
    ).catch(() => [])) ?? []) as any[];
    expect(left.filter((c) => c.title === title), 'no empty conversation stays behind').toHaveLength(0);
  }, 90_000);
});
