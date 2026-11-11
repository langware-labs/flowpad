/**
 * "Ask someone for help" from the vibe workspace — the ONE get-help affordance,
 * driven through the REAL browser UI, across two instances.
 *
 *   alice (dev-1, browser): opens her vibe workspace, clicks the raised-hand button and fills the
 *          one screen: what is wrong, diagnosis & context (both on by default; Review opens the
 *          message review on what will be sent), who gets it (bob), Diagnose and Send.
 *   → ONE help request: a TASK assigned to bob, and a conversation holding ONE help_request message
 *     with the issue text, the task chip, and the diagnosis + context as ordinary files.
 *   bob (dev-2): the task arrives unassisted; the message's files are staged on his side, and in
 *          his browser the diagnosis chip opens the SAME message review — before installing.
 *
 * The point of driving the browser is that only the UI wires title+notes into
 * the message body and defaults the transcript on — asserting `Task.assign`
 * directly would skip exactly the code this feature changed.
 *
 * Requires the local hub (8093) + dev-1/dev-2 launched WITH frontends:
 *   scripts/instance_ctl.sh launch dev-1 && scripts/instance_ctl.sh launch dev-2
 *   (cd ui && FLOWPAD_HUB_URL=http://localhost:8093 npx vitest run --project hub vibe_ask_help)
 * Skips otherwise. Do NOT raise a timeout here without explicit approval.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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
  queryMessageAttachments,
  syncAssignedConversation,
  type ResolvedInstance,
} from './_instances';
import { launchBrowser, openInstancePage, type InstancePage } from './_browser';
import { adjusted } from '../adjustableTimeout';

let skipReason: string | null = null;
let alice: ResolvedInstance;
let bob: ResolvedInstance;
let browser: Browser;
let alicePage: InstancePage;

const token = randomUUID().slice(0, 8);
const TITLE = `help me with the login flow ${token}`;
const NOTES = `It 500s on submit. Detail token: ${token}`;
const SESSION_ID = randomUUID();

let projectId = '';
let workdir = '';
let processId = '';
let taskId = '';
let conversationId = '';
let fmId = '';

const getApi = (apiUrl: string, p: string) => fetch(`${apiUrl}/api/v1${p}`).then((r) => r.json());

/** A minimal but REAL claude transcript on disk for the process's session, in
 *  the encoded-project layout `get_claude_session` resolves (`/`→`-`). Without
 *  it the default-on checkbox would silently downgrade to "not attached", and
 *  the test would pass while proving nothing about the transcript. */
function seedTranscript(): void {
  const dir = path.join(process.env.FLOWPAD_CLAUDE_HOME || path.join(os.homedir(), '.claude'), 'projects', workdir.replace(/\//g, '-'));
  mkdirSync(dir, { recursive: true });
  const lines = [
    { type: 'user', timestamp: new Date(0).toISOString(), message: { role: 'user', content: `vibe session ${token}` } },
    { type: 'assistant', timestamp: new Date(0).toISOString(), message: { role: 'assistant', content: 'on it' } },
  ];
  writeFileSync(path.join(dir, `${SESSION_ID}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'));
}

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
}, adjusted(60_000));

afterAll(async () => {
  await browser?.close().catch(() => undefined);
});

beforeEach((ctx: any) => {
  if (skipReason) {
    console.error(`[vibe-ask-help] SKIP: ${skipReason}`);
    ctx.skip();
  }
});

describe('vibe workspace — one ask-for-help button: task + message to bob', () => {
  it('alice has a vibe session with a transcript on disk', async () => {
    workdir = mkdtempSync(path.join(os.tmpdir(), 'flowpad-ask-help-'));
    const project = await postApi(alice.apiUrl, '/graph/project', {
      name: path.basename(workdir),
      fs_storage_mount_path: workdir,
    });
    projectId = project?.data?.id;
    expect(projectId, JSON.stringify(project)).toBeTruthy();

    // An idle process is enough: nothing here needs a live worker, only the
    // session identity the transcript hangs off.
    const node = await alice.sdk.ComputeNode.getById('@local');
    expect(node, 'local compute node').toBeTruthy();
    const proc: any = await node!.createProcess(
      { workdir, projectId, targetVfsPath: new alice.sdk.TypeId('project', projectId).toString() },
      { watchProcess: false, pty_mode: false },
    );
    processId = proc.id;
    proc.session_id = SESSION_ID;
    await proc.save();

    seedTranscript();
    const raw = await getApi(
      alice.apiUrl,
      `/graph/compute_node/@local/session-transcript-raw?session_id=${SESSION_ID}&project=${encodeURIComponent(workdir)}`,
    );
    expect(raw?.data?.content, 'the backend can read the seeded transcript').toContain(token);
  }, adjusted(30_000));

  it('alice asks bob for help from the vibe workspace — one button, one dialog', async () => {
    const { page } = alicePage;
    await page.goto(
      `${alicePage.feUrl}/dock/shell/agentic_process-${processId}` +
        `?viewMode=vibe&scope-mode=project&scope-activeProjectId=${projectId}`,
      { waitUntil: 'domcontentloaded' },
    );

    // Exactly ONE get-help affordance in the workspace toolbar — the collaborate
    // twin is gone, and its absence is part of the contract.
    const ask = page.getByTestId('vibe-assign-task');
    await ask.waitFor({ state: 'visible', timeout: adjusted(25_000) });
    expect(await page.getByTestId('vibe-collaborate').count()).toBe(0);
    expect(await page.getByTestId('vibe-collaborate-open').count()).toBe(0);
    // The Help desk moved from the footer into the first card -- same icon, same action.
    expect(await page.getByTestId('footer-helpdesk-button').count(), 'no Help desk in the footer').toBe(0);
    await ask.click();
    await page.getByTestId('ask-for-help-helpdesk-button').waitFor({ state: 'visible', timeout: 10_000 });

    // One screen — what is wrong.
    const notes = page.getByTestId('vibe-assign-notes');
    await notes.waitFor({ state: 'visible', timeout: 10_000 });
    await notes.fill(`${TITLE}\n\n${NOTES}`);

    // Diagnosis & context, both on by default (asserted, not set). Review is the message review
    // of exactly what will be sent.
    expect(await page.getByTestId('ask-for-help-run-diagnosis').isChecked()).toBe(true);
    expect(await page.getByTestId('ask-for-help-share-context').isChecked()).toBe(true);
    await page.getByTestId('ask-for-help-review-content').click();
    const review = page.getByTestId('content-review-dialog');
    await review.waitFor({ state: 'visible', timeout: 25_000 });
    await page.getByTestId('content-review-row-diagnosis.value.json').waitFor({ state: 'visible' });
    expect(await page.getByText('Context to share — review before sending.').count()).toBe(1);
    await page.getByTestId('content-review-share').click();
    await review.waitFor({ state: 'detached', timeout: 10_000 });

    // Who gets it. The radix focus trap swallows the first keystrokes: click, settle, type.
    const remove = page.getByTestId('ask-for-help-desk-remove');
    // The desks load after the dialog opens: wait for them, then ask bob only.
    await remove.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
    if (await remove.count()) await remove.click();
    const person = page.getByTestId('vibe-assign-person');
    await person.click();
    await page.waitForTimeout(500);
    await person.pressSequentially(bob.email, { delay: 15 });
    if ((await person.inputValue()) !== bob.email) await person.fill(bob.email);
    await person.blur();

    const submit = page.getByTestId('vibe-assign-submit');
    expect(await submit.isEnabled(), 'Send enabled with the email typed').toBe(true);
    await submit.click();
    // The wizard closes itself on success and the conversation opens.
    await submit.waitFor({ state: 'detached', timeout: adjusted(25_000) });
    await page.getByTestId('help-request-chip').first().waitFor({ state: 'visible', timeout: adjusted(25_000) });
  }, adjusted(90_000));

  it('the task exists on alice, assigned to bob', async () => {
    const task = await pollUntil(
      async () => {
        const rows: any[] = ((await alice.sdk.Task.query(
          new alice.sdk.QueryRequest({ type: 'task', query: { title: TITLE }, name: 'ask-help task' }),
          true,
        ).catch(() => [])) ?? []) as any[];
        return rows.find((t) => t.title === TITLE) ?? null;
      },
      20_000,
      'the ask-for-help task on alice',
    );
    taskId = task.id;
    expect(task.assignee).toBe(bob.email);
    // A help request is a `kind=vibe` task (what the raised-hand button lists) —
    // never a one-member group.
    expect(task.kind).toBe('vibe');
    expect(task.group_name ?? null).toBeNull();
    expect(task.description, 'the notes become the task body').toContain(token);
  }, adjusted(30_000));

  it('the task lands on bob — one row, no accept, no install', async () => {
    const bobTasks = async () =>
      ((await bob.sdk.Task.query(
        new bob.sdk.QueryRequest({ type: 'task', query: {}, name: 'bob tasks (ask-help)' }),
        true,
      ).catch(() => [])) ?? []) as any[];

    // The SAME task alice created — assignment shares it, it does not clone it.
    const landed = await pollUntil(
      async () => (await bobTasks()).find((t) => t.id === taskId) ?? null,
      25_000,
      'assigned task delivered to bob with him doing nothing',
    );
    expect(landed.assignee).toBe(bob.email);
    expect(landed.title).toBe(TITLE);
    expect(landed.parent_id ?? '', 'no member-task child shape').toBe('');

    // Exactly ONE row for this ask, on either side.
    const mine = (await bobTasks()).filter((t) => t.title === TITLE);
    expect(mine, 'one ask, one task row').toHaveLength(1);
  }, adjusted(30_000));

  it('a message went out to bob carrying the issue, the task, and the transcript', async () => {
    // The notification conversation is titled after the task (Task.assign).
    const conv = await pollUntil(
      async () => {
        const rows: any[] = ((await alice.sdk.Conversation.query(
          new alice.sdk.QueryRequest({ type: 'conversation', query: { title: TITLE }, name: 'ask-help conv' }),
          true,
        ).catch(() => [])) ?? []) as any[];
        return rows.find((c) => c.title === TITLE) ?? null;
      },
      20_000,
      'the notification conversation on alice',
    );
    conversationId = conv.id;
    expect(conv.remote, 'it is a real cross-user conversation').toBe(true);

    const msg = await pollUntil(
      async () => {
        const rows: any[] = ((await alice.sdk.FlowMessage.query(
          new alice.sdk.QueryRequest({
            type: 'flow_message',
            query: { conversation_id: conversationId },
            name: 'ask-help message',
          }),
          true,
        ).catch(() => [])) ?? []) as any[];
        return rows.find((m) => (m.message ?? m.text ?? '').includes(token)) ?? null;
      },
      20_000,
      'the outbound message on alice',
    );
    fmId = msg.id;
    const text = String(msg.message ?? msg.text ?? '');
    expect(text, 'the issue as written').toContain(TITLE);
    expect(text, 'the notes ride along').toContain(NOTES);
    expect(msg.kind, 'it is a help request').toBe('help_request');
  }, adjusted(30_000));

  it('bob receives ONE message: the issue, the task chip, and the diagnosis + context as files', async () => {
    await syncAssignedConversation(bob, conversationId);

    const received = await pollUntil(async () => {
      const fm: any = await bob.sdk.FlowMessage.getById(fmId).catch(() => null);
      return fm && fm.body_status === 'ready' ? fm : null;
    }, 25_000, 'the message READY on bob');
    expect(received.kind, 'bob reads it as a help request too (re-derived from its carrier)').toBe('help_request');
    await postApi(bob.apiUrl, `/graph/flow_message/${received.id}/download_body`, {});

    const attachments = await pollUntil(
      async () => {
        const rows = await queryMessageAttachments(bob, fmId);
        return rows.some((a: any) => a.name === 'diagnosis.value.json') ? rows : null;
      },
      25_000,
      'attachments materialized on bob',
    );
    const refs = attachments.map((a: any) => `${a.asset_type}-${a.asset_id}`);
    expect(refs.filter((r) => r.startsWith('task-')), `task chips in ${refs.join(',')}`).toEqual([`task-${taskId}`]);
    const files = attachments.filter((a: any) => a.asset_type === 'file').map((a: any) => a.name);
    expect(files).toEqual(expect.arrayContaining(['diagnosis.value.json', 'screen.value.json']));

    const msgs: any[] = ((await alice.sdk.FlowMessage.query(
      new alice.sdk.QueryRequest({ type: 'flow_message', query: { conversation_id: conversationId }, name: 'ask-help all' }),
      true,
    ).catch(() => [])) ?? []) as any[];
    expect(msgs, 'one request is one message — no diagnosis message after it').toHaveLength(1);
  }, adjusted(60_000));

  it('in bob\'s browser the diagnosis opens the same message review — before installing', async () => {
    const bobPage = await openInstancePage(browser, INST_2);
    const { page } = bobPage;
    await page.goto(`${bobPage.feUrl}/dock/conversation/${conversationId}`, { waitUntil: 'domcontentloaded' });
    const chip = page.getByText('diagnosis.value.json').or(page.getByText('Diagnosis', { exact: true })).first();
    await chip.waitFor({ state: 'visible', timeout: adjusted(25_000) }).catch(async (e) => {
      await page.screenshot({ path: path.join(os.tmpdir(), `ask-help-accept-fail-${token}.png`) });
      throw e;
    });
    await chip.click();
    const dialog = page.getByTestId('asset-review-dialog');
    await dialog.waitFor({ state: 'visible', timeout: adjusted(10_000) });
    expect(await dialog.getByText(/review before (installing|copying)/).count()).toBe(1);
    expect(await dialog.getByTestId(/asset-review-row-/).count(), 'every file of the message is listed').toBeGreaterThan(1);
    await bobPage.page.screenshot({ path: path.join(os.tmpdir(), `ask-help-accept-${token}.png`) });
  }, adjusted(60_000));
});

describe('the help desk (preselected): it is just a conversation', () => {
  it('Diagnose and Send opens the conversation — no ticket state, no Close ticket', async () => {
    const { page } = alicePage;
    await page.goto(`${alicePage.feUrl}/dock/shell/agentic_process-${processId}?viewMode=vibe&scope-mode=project&scope-activeProjectId=${projectId}`, {
      waitUntil: 'domcontentloaded',
    });
    const ask = page.getByTestId('vibe-assign-task');
    await ask.waitFor({ state: 'visible', timeout: 25_000 });
    await ask.click();
    const newAsk = page.getByTestId('vibe-help-new');
    if (await newAsk.count()) await newAsk.click();
    await page.getByTestId('vibe-assign-notes').fill(`desk please ${token}`);
    await page.getByTestId('ask-for-help-desks').waitFor({ state: 'visible', timeout: 10_000 });
    await page.getByTestId('vibe-assign-submit').click();

    await page.getByTestId('help-request-chip').first().waitFor({ state: 'visible', timeout: 25_000 });
    expect(await page.getByText('Waiting for pickup').count(), 'no queue state on the asker side').toBe(0);
    expect(await page.getByText('Close ticket').count(), 'nothing to settle on the asker side').toBe(0);
    await page.screenshot({ path: path.join(os.tmpdir(), `ask-help-desk-${token}.png`) });
  }, 90_000);
});
