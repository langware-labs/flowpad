/**
 * The task editor's "Owner" pill actually DELIVERS the task — real browser, two
 * instances.
 *
 * This surface used to be a second, worse assign path: it wrote `assignee`
 * locally and sent a chip message, but granted the recipient no role, so the
 * "assignee" got a notification about a task that never arrived on their machine.
 * It now commits through the ONE path (`Task.assign` → `assign-task` = share +
 * one editor invite), and this test's whole point is the delivery assertion the
 * old path could not have passed.
 *
 * Requires the local hub (8093) + dev-1/dev-2 launched WITH frontends:
 *   scripts/instance_ctl.sh launch dev-1 && scripts/instance_ctl.sh launch dev-2
 *   (cd ui && FLOWPAD_HUB_URL=http://localhost:8093 npx vitest run --project hub task_owner_assign)
 * Skips otherwise. Do NOT raise a timeout here without explicit approval.
 */
import { randomUUID } from 'node:crypto';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { hubAvailable } from './_hub';
import { pollUntil } from './_matrix';
import {
  HUB_INST_1 as INST_1,
  HUB_INST_2 as INST_2,
  getInstance,
  instanceAvailable,
  postApi,
  type ResolvedInstance,
} from './_instances';
import { launchBrowser, openInstancePage, type InstancePage } from './_browser';

let skipReason: string | null = null;
let alice: ResolvedInstance;
let bob: ResolvedInstance;
let browser: Browser;
let alicePage: InstancePage;

const token = randomUUID().slice(0, 8);
const TITLE = `owner pill assign ${token}`;
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
}, 60_000);

afterAll(async () => {
  await browser?.close().catch(() => undefined);
});

beforeEach((ctx: any) => {
  if (skipReason) {
    console.error(`[task-owner-assign] SKIP: ${skipReason}`);
    ctx.skip();
  }
});

describe('task editor Owner pill — assigning hands the task over for real', () => {
  it('alice assigns her task to bob from the Owner pill', async () => {
    const created = await postApi(alice.apiUrl, '/graph/task', {
      title: TITLE,
      description: `needs an owner — ${token}`,
    });
    taskId = created?.data?.id;
    expect(taskId, JSON.stringify(created)).toBeTruthy();

    const { page } = alicePage;
    await page.goto(`${alicePage.feUrl}/dock/assets/editor/task/typeid/task-${taskId}?viewMode=advanced`, {
      waitUntil: 'domcontentloaded',
    });

    const pill = page.getByTestId('task-owner-button');
    await pill.waitFor({ state: 'visible', timeout: 25_000 });
    await pill.click();
    await page.getByTestId('task-owner-individual').click();

    // ContactPicker takes a free-form email; the popover's open animation eats
    // the first keystrokes, so click → settle → type → verify (driveShareDialog).
    const contact = page.getByPlaceholder('Search a contact or type an email');
    await contact.waitFor({ state: 'visible', timeout: 10_000 });
    await contact.click();
    await page.waitForTimeout(500);
    await contact.pressSequentially(bob.email, { delay: 15 });
    if ((await contact.inputValue()) !== bob.email) await contact.fill(bob.email);
    await contact.press('Enter');

    await page.getByTestId('task-owner-message').fill(`please own this — ${token}`);
    await page.getByTestId('task-owner-assign').click();
    await page.getByTestId('task-owner-assign').waitFor({ state: 'detached', timeout: 25_000 });
  }, 60_000);

  it('the task is on bob — the old Owner-pill path never delivered it', async () => {
    const landed = await pollUntil(
      async () => {
        const rows = ((await bob.sdk.Task.query(
          new bob.sdk.QueryRequest({ type: 'task', query: {}, name: 'bob tasks (owner pill)' }),
          true,
        ).catch(() => [])) ?? []) as any[];
        return rows.find((t) => t.id === taskId) ?? null;
      },
      25_000,
      'the task delivered to bob by the Owner pill',
    );
    expect(landed.assignee).toBe(bob.email);
    expect(landed.title).toBe(TITLE);
    expect(landed.parent_id ?? '', 'one shared row, no member-task clone').toBe('');
  }, 30_000);

  it("alice's task stays a plain task", async () => {
    const mine = await fetch(`${alice.apiUrl}/api/v1/graph/task/${taskId}`).then((r) => r.json());
    expect(mine?.data?.assignee).toBe(bob.email);
    expect(mine?.data?.kind ?? 'standard').toBe('standard');
    expect(mine?.data?.group_name ?? null).toBeNull();
    const kids = ((await alice.sdk.Task.query(
      new alice.sdk.QueryRequest({ type: 'task', query: { parent_id: taskId }, name: 'children' }),
      true,
    ).catch(() => [])) ?? []) as any[];
    expect(kids, 'no child task').toHaveLength(0);
  }, 30_000);
});
