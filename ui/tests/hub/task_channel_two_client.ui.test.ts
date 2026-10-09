/**
 * Tasks in conversations — real browsers, three instances, the local hub. Every step is done by the person
 * who would do it, in their own browser.
 *
 * A task made from a message is local and private (a local glyph, "This task is local on this machine"),
 * and its thread opens in the maker's stream inbox (their Tasks channel — an ordinary channel
 * conversation). Handing it to someone shares it through the cloud; from then on both people read the
 * same thread, and each change — status, hand-over, rename — is one message credited to who made it.
 *
 *   1 alice "Task it"s a message → local glyph, owner "Me"; the thread opens in her stream inbox
 *   2 alice hands it to bob from the message's owner chip (a member quick pick) → cloud glyph; bob has it
 *   3 bob moves it from his thread's chip → alice's message chip, her thread and her task editor follow
 *   4 alice moves it in her task editor → bob's thread and chip follow
 *   5 bob replies in his thread → alice reads it in her thread and on the task (its comments)
 *   6 Done → In progress → Done: every change its own message, on both sides
 *   7 alice renames the task → both threads follow
 *   8 alice hands it to carol (address book / email) → bob's thread ends with the hand-over, carol has it
 *   9 the thread shows no task-id address and no "not picked up yet" line
 *
 * Requires the local hub (8093) + three launcher-owned instances WITH frontends, launched one at a time:
 *   scripts/instance_ctl.sh launch dev-1 && scripts/instance_ctl.sh launch dev-2 && scripts/instance_ctl.sh launch dev-3
 *   (cd ui && env -u LOCAL_SERVER_PORT FLOWPAD_HUB_URL=http://localhost:8093 SHARE_INST_1=dev-1 SHARE_INST_2=dev-2 \
 *      CAROL_INST=dev-3 ALICE_EMAIL=dev-1@local.test ALICE_PW=dev-1-pw-1234 BOB_EMAIL=dev-2@local.test \
 *      BOB_PW=dev-2-pw-1234 npx vitest run --project hub task_channel_two_client)
 * `SHOT_DIR=<dir>` saves a screenshot per step. Skips without the instances. Do NOT raise a timeout here
 * without explicit approval.
 */
import { randomUUID } from 'node:crypto';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { hubAvailable } from './_hub';
import { pollUntil } from './_matrix';
import {
  HUB_INST_1 as INST_1,
  HUB_INST_2 as INST_2,
  getInstance,
  instanceAvailable,
  postApi,
  readEnvFile,
  type ResolvedInstance,
} from './_instances';
import { launchBrowser, openConversation, openInstancePage, type InstancePage } from './_browser';

const CAROL_INST = process.env.CAROL_INST?.trim() || '';
const SHOT_DIR = process.env.SHOT_DIR?.trim() || '';

let skipReason: string | null = null;
let alice: ResolvedInstance;
let bob: ResolvedInstance;
let browser: Browser;
let alicePage: InstancePage;
let bobPage: InstancePage;
let carolPage: InstancePage | null = null;
let carolEmail = '';

const token = randomUUID().slice(0, 8);
const TITLE = `Set up the studio ${token}`;
const RENAMED = `Set up the studio and CRM ${token}`;
const REPLY = `On it, will report ${token}`;
let conversationId = '';
let taskId = '';

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
  bobPage = await openInstancePage(browser, INST_2);
  if (CAROL_INST) {
    const env = await readEnvFile(CAROL_INST);
    const status = await fetch(`http://localhost:${env.LOCAL_SERVER_PORT}/api/v1/cloud/status`).then((r) => r.json());
    carolEmail = String(status?.data?.login?.user?.email ?? '');
    if (carolEmail) carolPage = await openInstancePage(browser, CAROL_INST);
  }
}, 90_000);

afterAll(async () => {
  await browser?.close().catch(() => undefined);
});

beforeEach((ctx: any) => {
  if (skipReason) {
    console.error(`[task-channel] SKIP: ${skipReason}`);
    ctx.skip();
  }
});

async function shot(inst: InstancePage, step: string): Promise<void> {
  if (SHOT_DIR) await inst.page.screenshot({ path: `${SHOT_DIR}/${step}-${inst.name}.png` });
}

async function seeText(page: Page, text: string, timeout = 20_000): Promise<void> {
  await page.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout });
}

/** Open a task's thread from the stream inbox: the Tasks channel's row titled by the task. (The conversation the
 *  task was made in also lists the title, in its preview — it is not the thread.) */
async function openThread(inst: InstancePage, title: string): Promise<void> {
  await inst.page.goto(`${inst.feUrl}/dock/stream_inbox?viewMode=advanced`, { waitUntil: 'domcontentloaded' });
  const row = inst.page
    .getByTestId('stream-inbox-conversation-row')
    .filter({ hasText: title })
    .filter({ hasText: 'Tasks' })
    .first();
  await row.waitFor({ state: 'visible', timeout: 20_000 });
  await row.click();
}

async function openTaskEditor(inst: InstancePage): Promise<void> {
  await inst.page.goto(`${inst.feUrl}/dock/assets/editor/task/typeid/task-${taskId}?viewMode=advanced`, {
    waitUntil: 'domcontentloaded',
  });
  await inst.page.getByTestId('task-editor-title').waitFor({ state: 'visible', timeout: 20_000 });
}

/** Pick a status from a task chip's menu (the message's, or the thread's first message's). */
async function chooseStatus(page: Page, status: 'to_do' | 'in_progress' | 'done'): Promise<void> {
  const chips = page.getByTestId('message-task-chips').first();
  await chips.waitFor({ state: 'visible', timeout: 20_000 });
  await chips.getByTestId('task-status-chip').click();
  await page.getByTestId(`task-status-${status}`).click();
}

async function count(page: Page, text: string): Promise<number> {
  return page.getByText(text, { exact: true }).count();
}

/** Open a thread and expand it — the stream inbox shows a thread collapsed to its newest message. */
async function openWholeThread(inst: InstancePage, title: string): Promise<void> {
  await openThread(inst, title);
  const expand = inst.page.getByTestId('thread-stack-open').first();
  await expand.waitFor({ state: 'visible', timeout: 20_000 });
  await expand.click();
}

describe('tasks in conversations — one thread both people read and act on', () => {
  it('1: alice Task-its a message — a local, private task, mine, with its thread in my stream inbox', async () => {
    const conv = new alice.sdk.Conversation({ title: `studio talk ${token}` });
    await conv.save();
    await conv.share([bob.email]); // bob is a member: a quick pick when handing the task over
    conversationId = conv.id;
    const added = await postApi(alice.apiUrl, `/graph/conversation/${conv.id}/add_message`, {
      message: `${TITLE}\nwith the CRM`,
    });
    const fmId = added?.data?.flow_message_id as string;
    expect(fmId, JSON.stringify(added)).toBeTruthy();

    const { page } = alicePage;
    await openConversation(alicePage, conv.id);
    const bubble = page.getByText(TITLE, { exact: false }).first();
    await bubble.waitFor({ state: 'visible', timeout: 20_000 });
    await bubble.hover();
    await page.getByTestId('message-actions-menu').first().click();
    await page.getByTestId('message-task-it').click();

    const owner = page.getByTestId('message-task-chips').first().getByTestId('task-owner-chip');
    await owner.waitFor({ state: 'visible', timeout: 20_000 });
    await expect.poll(() => owner.textContent()).toContain('Me');
    expect(await owner.getAttribute('title')).toBe('This task is local on this machine');
    expect(await owner.locator('[data-task-location="local"]').count()).toBe(1);

    const task = await pollUntil(
      async () => {
        const rows = ((await alice.sdk.Task.query(
          new alice.sdk.QueryRequest({ type: 'task', query: { origin_message: fmId }, name: `task-it ${token}` }),
          true,
        ).catch(() => [])) ?? []) as any[];
        return rows[0] ?? null;
      },
      15_000,
      'the task made from the message',
    );
    taskId = task.id;
    await shot(alicePage, '1-message');

    await openThread(alicePage, TITLE);
    await seeText(page, 'with the CRM');
    await page.getByTestId('message-task-chips').first().waitFor({ state: 'visible', timeout: 20_000 });
    await shot(alicePage, '1-thread');
  }, 120_000);

  it('2: alice hands it to bob from the message — shared through the cloud, bob has the thread', async () => {
    const { page } = alicePage;
    await openConversation(alicePage, conversationId);
    const chips = page.getByTestId('message-task-chips').first();
    await chips.waitFor({ state: 'visible', timeout: 20_000 });
    await chips.getByTestId('task-owner-chip').click();
    await page.locator(`[data-testid="task-owner-member"][data-email="${bob.email}"]`).click();

    const owner = chips.getByTestId('task-owner-chip');
    await owner.locator('[data-task-location="cloud"]').waitFor({ state: 'attached', timeout: 20_000 });
    expect(await owner.getAttribute('title')).toBe(`Shared via cloud with ${bob.email}`);
    await shot(alicePage, '2-message');

    await openThread(bobPage, TITLE);
    await seeText(bobPage.page, `Assigned to ${bob.email}`);
    await shot(bobPage, '2-thread');
  }, 90_000);

  it('3: bob moves it from his thread — alice sees it on her message, in her thread and in her task', async () => {
    await chooseStatus(bobPage.page, 'in_progress');
    await seeText(bobPage.page, 'Status: In progress');

    await openConversation(alicePage, conversationId);
    const status = alicePage.page.getByTestId('message-task-chips').first().getByTestId('task-status-chip');
    await expect.poll(() => status.textContent(), { timeout: 20_000 }).toBe('In progress');
    await openThread(alicePage, TITLE);
    await seeText(alicePage.page, 'Status: In progress');
    await shot(alicePage, '3-thread');
    await openTaskEditor(alicePage);
    await expect
      .poll(() => alicePage.page.getByTestId('task-editor-status-in_progress').getAttribute('class'), { timeout: 20_000 })
      .toContain('bg-primary');
  }, 90_000);

  it('4: alice moves it in her task editor — bob\'s thread and chip follow', async () => {
    await openTaskEditor(alicePage);
    await alicePage.page.getByTestId('task-editor-status-done').click();
    await openThread(bobPage, TITLE);
    await seeText(bobPage.page, 'Status: Done');
    const status = bobPage.page.getByTestId('message-task-chips').first().getByTestId('task-status-chip');
    await expect.poll(() => status.textContent(), { timeout: 20_000 }).toBe('Done');
    await shot(bobPage, '4-thread');
  }, 90_000);

  it('5: bob replies in his thread — alice reads it in her thread and on the task', async () => {
    const composer = bobPage.page.getByRole('textbox').last();
    await composer.waitFor({ state: 'visible', timeout: 15_000 });
    await composer.click();
    await composer.fill(REPLY);
    await composer.press('Enter');
    await seeText(bobPage.page, REPLY);

    await openThread(alicePage, TITLE);
    await seeText(alicePage.page, REPLY);
    await openTaskEditor(alicePage);
    await seeText(alicePage.page, REPLY);
    await shot(alicePage, '5-task');
  }, 90_000);

  it('6: Done → In progress → Done — every change is its own message, on both sides', async () => {
    await openWholeThread(bobPage, TITLE);
    await chooseStatus(bobPage.page, 'in_progress');
    await expect.poll(() => count(bobPage.page, 'Status: In progress'), { timeout: 20_000 }).toBe(2);
    await chooseStatus(bobPage.page, 'done');
    await expect.poll(() => count(bobPage.page, 'Status: Done'), { timeout: 20_000 }).toBe(2);

    await openWholeThread(alicePage, TITLE);
    await expect.poll(() => count(alicePage.page, 'Status: Done'), { timeout: 20_000 }).toBe(2);
    expect(await count(alicePage.page, 'Status: In progress')).toBe(2);
    await shot(alicePage, '6-thread');
  }, 90_000);

  it('7: alice renames the task — both threads follow', async () => {
    // Let step 6's last move land first: a hub refresh arriving mid-typing resets the editor's field.
    await pollUntil(
      async () => ((await fetch(`${alice.apiUrl}/api/v1/graph/task/${taskId}`).then((r) => r.json()))?.data?.status === 'done' ? true : null),
      15_000,
      "step 6's last move on alice's task",
    );
    await openTaskEditor(alicePage);
    const title = alicePage.page.getByTestId('task-editor-title');
    await expect.poll(() => title.inputValue(), { timeout: 15_000 }).toBe(TITLE);
    await title.fill(RENAMED);
    await title.press('Enter');
    await pollUntil(
      async () => ((await fetch(`${alice.apiUrl}/api/v1/graph/task/${taskId}`).then((r) => r.json()))?.data?.title === RENAMED ? true : null),
      15_000,
      'the rename saved',
    );

    for (const inst of [alicePage, bobPage]) {
      await openThread(inst, RENAMED);
      await seeText(inst.page, `Renamed to ${RENAMED}`);
    }
    await shot(bobPage, '7-thread');
  }, 90_000);

  it('8: alice hands it to carol — bob\'s thread ends with the hand-over, carol has the thread', async (ctx: any) => {
    if (!carolPage || !carolEmail) {
      console.error('[task-channel] step 8 needs CAROL_INST (a third logged-in instance)');
      return ctx.skip();
    }
    const { page } = alicePage;
    await openConversation(alicePage, conversationId);
    const chips = page.getByTestId('message-task-chips').first();
    await chips.getByTestId('task-owner-chip').click();
    const search = page.getByTestId('task-owner-search');
    await search.click();
    await page.waitForTimeout(400); // the popover's open animation eats the first keystrokes
    await search.pressSequentially(carolEmail, { delay: 15 });
    if ((await search.inputValue()) !== carolEmail) await search.fill(carolEmail);
    await search.press('Enter');
    await page.getByTestId('task-owner-assign').click();

    await openThread(bobPage, RENAMED);
    await seeText(bobPage.page, `Reassigned to ${carolEmail}`);
    await shot(bobPage, '8-thread');
    await openThread(carolPage, RENAMED);
    await seeText(carolPage.page, `Reassigned to ${carolEmail}`);
    await shot(carolPage, '8-thread');
  }, 90_000);

  it('9: the whole thread is there, waits for no one and names no task id', async () => {
    await openWholeThread(bobPage, RENAMED);
    for (const said of [TITLE, `Assigned to ${bob.email}`, 'Status: In progress', REPLY, `Renamed to ${RENAMED}`, `Reassigned to`]) {
      await seeText(bobPage.page, said);
    }
    await shot(bobPage, '9-thread');
    expect(await bobPage.page.getByText('not picked up yet', { exact: false }).count()).toBe(0);
    expect(await bobPage.page.getByText(taskId, { exact: false }).count()).toBe(0);
  }, 60_000);
});
