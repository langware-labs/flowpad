/**
 * "Ask someone for help" from the vibe workspace — the ONE get-help affordance,
 * driven through the REAL browser UI, across two instances.
 *
 *   alice (dev-1, browser): opens her vibe workspace, clicks the raised-hand button,
 *          picks bob, writes the issue, submits. The transcript checkbox is ON
 *          by default and she leaves it that way.
 *   → the click must produce BOTH halves of the contract:
 *        1. a TASK, assigned to bob — it lands on his board with no accept;
 *        2. a CONVERSATION message to bob carrying the issue text, the ONE task
 *           chip, and the session transcript.
 *   bob (dev-2, SDK): the task itself arrives unassisted — assignment shares it
 *          rather than cloning a "member task"; he accepts the invitation and
 *          reads the message + its transcript attachment.
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
  findPendingInvitation,
  getInstance,
  instanceAvailable,
  postApi,
  queryMessageAttachments,
  type ResolvedInstance,
} from './_instances';
import { launchBrowser, openInstancePage, type InstancePage } from './_browser';

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
  const dir = path.join(os.homedir(), '.claude', 'projects', workdir.replace(/\//g, '-'));
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
}, 60_000);

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
  }, 30_000);

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
    await ask.waitFor({ state: 'visible', timeout: 25_000 });
    expect(await page.getByTestId('vibe-collaborate').count()).toBe(0);
    expect(await page.getByTestId('vibe-collaborate-open').count()).toBe(0);
    await ask.click();

    // The Radix dialog's open animation + focus trap swallow the first
    // keystrokes; click, settle, type, verify (same shape as driveShareDialog).
    const person = page.getByTestId('vibe-assign-person');
    await person.waitFor({ state: 'visible', timeout: 10_000 });
    await person.click();
    await page.waitForTimeout(500);
    await person.pressSequentially(bob.email, { delay: 15 });
    if ((await person.inputValue()) !== bob.email) await person.fill(bob.email);
    await person.press('Enter');

    await page.getByTestId('vibe-assign-title').fill(TITLE);
    await page.getByTestId('vibe-assign-notes').fill(NOTES);

    // Default ON — asserted, not set. The user never ticks this box.
    const transcript = page.locator('input[type="checkbox"]').first();
    await expect.poll(() => transcript.isChecked(), { timeout: 5_000 }).toBe(true);

    await page.getByTestId('vibe-assign-submit').click();
    // The dialog closes itself on success; a dialog still showing the form is
    // the failure signal.
    await page.getByTestId('vibe-assign-submit').waitFor({ state: 'detached', timeout: 25_000 });
  }, 60_000);

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
    // The ask leaves her task a PLAIN task — it is not a one-member group.
    expect(task.kind ?? 'standard').toBe('standard');
    expect(task.group_name ?? null).toBeNull();
    expect(task.description, 'the notes become the task body').toContain(token);
  }, 30_000);

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
  }, 30_000);

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
    expect(text, 'the title leads — the issue is legible without the notes').toContain(TITLE);
    expect(text, 'the notes ride along').toContain(NOTES);
  }, 30_000);

  it('bob accepts and receives the issue, the task chips, and the transcript', async () => {
    const invitation = await pollUntil(
      () => findPendingInvitation(bob, conversationId),
      25_000,
      'pending invitation on bob',
    );
    await bob.sdk.acceptInvitation({ invitation_id: invitation.id! });

    const received = await pollUntil(async () => {
      const fm: any = await bob.sdk.FlowMessage.getById(fmId).catch(() => null);
      return fm && fm.body_status === 'ready' ? fm : null;
    }, 25_000, 'the message READY on bob');
    await postApi(bob.apiUrl, `/graph/flow_message/${received.id}/download_body`, {});

    const attachments = await pollUntil(
      async () => {
        const rows = await queryMessageAttachments(bob, fmId);
        return rows.length ? rows : null;
      },
      25_000,
      'attachments materialized on bob',
    );
    const refs = attachments.map((a: any) => `${a.asset_type}-${a.asset_id}`);
    // ONE task chip — the task itself. The old group-of-one shape shipped two
    // (the assignee's member task plus the parent overview).
    const taskChips = refs.filter((r) => r.startsWith('task-'));
    expect(taskChips, `task chips in ${refs.join(',')}`).toEqual([`task-${taskId}`]);
    expect(
      refs.some((r) => r === `claude_session-${SESSION_ID}`),
      `transcript chip (attached by default) in ${refs.join(',')}`,
    ).toBe(true);
  }, 60_000);
});
