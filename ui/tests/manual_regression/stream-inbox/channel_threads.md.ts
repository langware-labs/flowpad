/**
 * Threads on every message channel, in the browser — the runbook is `channel_threads.md`.
 *
 * Per channel, the person writes a root and two more messages in its thread (the way that channel
 * continues a thread, quoting the root where it can). From the base stream inbox we open the
 * conversation and check, as receiver: the thread packs into one stack with the right count, opens
 * by URL (`?thread=`) under a header naming it, quotes render where the channel carries them, and
 * "All messages" leads back. As sender: the open thread's composer lands a send in THAT provider
 * thread, and Reply on the root reaches the provider as a reply to the root; our copy joins the thread.
 *
 * Providers are the loopback doubles `tests/e2e/channel_doubles.py` hosts (spawned under the
 * instance's FLOW_INSTANCE); the backend talks to them exactly as it would to the real hosts.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { REPO_ROOT, apiContext, apiOrigin, configuredFileEnv } from '../_shared/api';
import { graphCall, sendButton, skipLlmSetup } from '../_shared/conversation';

const INSTANCE = process.env.FLOW_INSTANCE || '';

interface Delivery {
  external_id: string;
  thread?: string;
}

/** How each channel continues a thread, as its double takes it. `quotesInbound`: the provider tells us
 *  which message a reply answers (a quote block renders). `quotes`: OUR reply quotes where the person
 *  reads (`ChannelSpec.quotes`) — else a reply only lands in the thread. */
const CHANNELS: Record<
  string,
  { follow: (root: Delivery) => Record<string, unknown>; quotesInbound: boolean; quotes: boolean }
> = {
  gmail: { follow: (r) => ({ thread: r.external_id }), quotesInbound: true, quotes: false }, // In-Reply-To the root
  slack: { follow: (r) => ({ thread: r.thread }), quotesInbound: false, quotes: false }, // thread_ts; no parent named
  telegram: { follow: (r) => ({ reply_to: r.external_id }), quotesInbound: true, quotes: true }, // the chat is the thread
  whatsapp: { follow: (r) => ({ reply_to: r.external_id }), quotesInbound: true, quotes: true }, // the person is the thread
  agentmail: { follow: (r) => ({ thread: r.thread }), quotesInbound: false, quotes: false },
  teams: { follow: (r) => ({ thread: r.thread }), quotesInbound: true, quotes: false }, // replyToId = the root
  // An agent's email: agent-only (the hub's local agent mailbox, AGENT_MAILBOX_ENABLED on the hub).
  cloud_email: { follow: (r) => ({ thread: r.thread }), quotesInbound: false, quotes: false },
};
const WANTED = (process.env.THREAD_CHANNELS || Object.keys(CHANNELS).join(',')).split(',').filter(Boolean);

interface ChannelEntry {
  config: Record<string, unknown>;
  fields?: Record<string, unknown>;
  secret_store?: { type: string; config: Record<string, unknown> };
  sender: string;
  agent_only?: boolean;
}

let api: APIRequestContext;
let doubles: ChildProcessWithoutNullStreams | undefined;
let control = '';
let channels: Record<string, ChannelEntry> = {};
let localUserId = '';
let agentId = '';
let agentMailboxSourceId = '';
const created: string[] = [];

async function controlJson<T>(method: 'GET' | 'POST', route: string, body?: unknown): Promise<T> {
  const res = await api.fetch(`${control}${route}`, { method, data: body });
  expect(res.ok(), `${method} ${route}: ${await res.text()}`).toBeTruthy();
  return (await res.json()) as T;
}

const graph = <T = Record<string, unknown>>(method: 'get' | 'post' | 'delete', route: string, data?: unknown) =>
  graphCall<T>(api, method, route, data);

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(180_000);
  api = await apiContext();
  const users = await graph<Array<{ id: string; uname?: string }>>('get', '/graph/user');
  localUserId = users.find((u) => u.uname === 'local')?.id ?? '';
  expect(localUserId, 'no local user row').toBeTruthy();

  doubles = spawn('uv', ['run', 'python', 'tests/e2e/channel_doubles.py', '--backend', apiOrigin(), '--channels', WANTED.join(',')], {
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
  channels = await controlJson<Record<string, ChannelEntry>>('GET', '/channels');

  // An agent-only channel (an agent's email) is opened per agent: it is not on /channels until the
  // agent, its mailbox, and the outsider that writes in exist.
  if (WANTED.some((c) => !channels[c])) {
    const agent = await graph<{ id: string }>('post', '/graph/agent', {
      name: `threads agent ${Date.now().toString(36)}`,
      worker_type: 'claude',
      system_prompt: 'Be brief.',
    });
    agentId = agent.id;
    const mailbox = await graph<{ mailbox?: { address?: string }; sources?: Array<{ id: string }> }>(
      'post',
      `/graph/agent/${agentId}/allocate_mailbox`,
      {},
    );
    const address = mailbox.mailbox?.address ?? '';
    expect(address, 'the hub allocated no address (is AGENT_MAILBOX_ENABLED on?)').toBeTruthy();
    agentMailboxSourceId = mailbox.sources?.[0]?.id ?? '';
    await controlJson('POST', '/agent_mailbox', { agent_id: agentId, address });
    channels = await controlJson<Record<string, ChannelEntry>>('GET', '/channels');
  }
});

test.afterAll(async () => {
  for (const id of created) await api.delete(`/api/v1/graph/data_source/${id}`);
  if (agentId) await api.delete(`/api/v1/graph/agent/${agentId}`);
  if (doubles && control) {
    const exited = new Promise<void>((resolve) => doubles!.once('exit', () => resolve()));
    await api.post(`${control}/shutdown`).catch(() => undefined);
    await exited;
  }
  doubles?.kill();
  await api.dispose();
});

async function open(page: Page, route: string) {
  await skipLlmSetup(page);
  await page.goto(route);
}

async function sourceFor(channel: string): Promise<string> {
  const entry = channels[channel];
  if (entry.agent_only) return agentMailboxSourceId; // the agent's own mailbox row
  const body: Record<string, unknown> = {
    name: `threads ${channel} ${Date.now().toString(36)}`,
    provider: channel,
    config: entry.config,
    owner: `user-${localUserId}`,
    inbound_allowed_senders: [],
    ...(entry.fields ?? {}),
  };
  if (entry.secret_store) body.secret_store = entry.secret_store;
  const source = await graph<{ id: string }>('post', '/graph/data_source', body);
  created.push(source.id);
  await graph('post', `/graph/data_source/${source.id}/verify`, {});
  return source.id;
}

async function sync(sourceId: string) {
  const report = await graph<{ health?: string; error_detail?: string }>('post', `/graph/data_source/${sourceId}/sync`, {});
  expect(report.health, `sync ${report.error_detail ?? ''}`).toBe('ok');
}

async function sentTo(channel: string): Promise<Array<Record<string, unknown>>> {
  return controlJson<Array<Record<string, unknown>>>('GET', `/sent?channel=${channel}`);
}

/** The last provider message carrying `text`, once it has left through the double. */
async function sentWith(channel: string, text: string): Promise<Record<string, unknown>> {
  await expect
    .poll(async () => JSON.stringify(await sentTo(channel)), { message: `${channel}: "${text}" never left through the double` })
    .toContain(text);
  return [...(await sentTo(channel))].reverse().find((m) => JSON.stringify(m).includes(text)) ?? {};
}

/** A provider id is sometimes namespaced (`<chat>/<id>`); the provider itself carries the last part. */
const bare = (id: string) => id.split('/').pop() ?? id;

for (const [i, channel] of WANTED.entries()) {
  test(`${i + 1}. ${channel}: a thread packs, opens by URL, and both a thread send and a reply land in the provider's thread`, async ({ page }) => {
    test.skip(!channels[channel], `${channel}: no double served`);
    const spec = CHANNELS[channel];
    const nonce = Math.random().toString(36).slice(2, 8);
    const sourceId = await sourceFor(channel);
    const shots = process.env.SHOT_DIR;

    // ── receiver: the person writes a root and two more in its thread ──
    const root = await controlJson<Delivery>('POST', '/deliver', { channel, text: `root ${nonce}` });
    await sync(sourceId);
    await controlJson('POST', '/deliver', { channel, text: `second ${nonce}`, ...spec.follow(root) });
    await sync(sourceId);
    const third = await controlJson<Delivery>('POST', '/deliver', { channel, text: `third ${nonce}`, thread: root.thread });
    await sync(sourceId);

    // From the base stream inbox: the conversation row, then the feed — one packed thread.
    const agentOnly = !!channels[channel]?.agent_only;
    await open(page, agentOnly ? `/dock/agent/${agentId}/stream_inbox` : '/dock/stream_inbox');
    const row = page.getByTestId('stream-inbox-conversation-row').filter({ hasText: nonce }).first();
    await expect(row).toBeVisible();
    await row.click();
    await expect(page.locator('[data-testid^="message-bubble-"]', { hasText: `third ${nonce}` }).first()).toBeVisible();
    const stackOpen = page.getByTestId('thread-stack-open');
    await expect(stackOpen).toContainText('2 earlier in this thread');
    if (shots) await page.screenshot({ path: `${shots}/${channel}-1-packed.png`, fullPage: true });

    // Open the thread: a navigation (?thread=) with a header naming and counting it.
    await stackOpen.click();
    await expect(page).toHaveURL(/[?&]thread=/);
    await expect(page.getByTestId('thread-header')).toBeVisible();
    await expect(page.getByTestId('thread-header-count')).toContainText('3 messages');
    for (const t of [`root ${nonce}`, `second ${nonce}`, `third ${nonce}`]) {
      // The bubble's own body (a quote block repeats its parent's words).
      await expect(page.locator('[data-testid^="message-bubble-"] .whitespace-pre-wrap', { hasText: t }).first()).toBeVisible();
    }
    if (spec.quotesInbound) {
      await expect(page.getByTestId('message-quote').filter({ hasText: `root ${nonce}` }).first()).toBeVisible();
    }
    if (shots) await page.screenshot({ path: `${shots}/${channel}-2-thread.png`, fullPage: true });

    // ── sender: the open thread's composer writes into THIS provider thread ──
    await expect(page.getByTestId('composer-thread-banner')).toBeVisible();
    const composer = page.getByPlaceholder(/^Reply in /);
    await composer.fill(`in thread ${nonce}`);
    await sendButton(page).click();
    const intoThread = await sentWith(channel, `in thread ${nonce}`);
    // The ids that place a provider message in this thread: its key, its root, its newest message.
    const inThread = (m: Record<string, unknown>) =>
      [root.thread, root.external_id, third.external_id].filter(Boolean).some((id) => JSON.stringify(m).includes(bare(id!)));
    if (!spec.quotes) {
      // A channel whose replies only thread files it under the thread (never as a new conversation).
      expect(inThread(intoThread), `${channel}: the thread send left outside the thread: ${JSON.stringify(intoThread)}`).toBe(true);
    } else {
      expect(intoThread.thread ?? null, `${channel}: a plain thread send must quote nobody`).toBeFalsy();
    }
    // Our copy joins the thread.
    await expect(page.getByTestId('thread-header-count')).toContainText('4 messages', { timeout: 15_000 });

    // Reply on the root (⋮ → Reply): the provider sees a reply to the root.
    const rootBubble = page.locator('[data-testid^="message-bubble-"]').filter({ hasText: `root ${nonce}` }).first();
    await rootBubble.getByTestId('message-actions-menu').click();
    await page.getByTestId('message-reply').click();
    await expect(page.getByTestId('composer-reply-banner')).toContainText(`root ${nonce}`);
    await composer.fill(`answer ${nonce}`);
    await sendButton(page).click();
    const answering = await sentWith(channel, `answer ${nonce}`);
    const namesRoot = [root.external_id, root.thread].filter(Boolean).some((id) => JSON.stringify(answering).includes(bare(id!)));
    expect(namesRoot, `${channel}: the reply does not name the root: ${JSON.stringify(answering)}`).toBe(true);
    await expect(page.getByTestId('thread-header-count')).toContainText('5 messages', { timeout: 15_000 });
    if (shots) await page.screenshot({ path: `${shots}/${channel}-3-replied.png`, fullPage: true });

    // Back to every message: the thread packs again.
    await page.getByTestId('thread-header-all').click();
    await expect(page).not.toHaveURL(/[?&]thread=/);
    await expect(page.getByTestId('thread-header')).toHaveCount(0);
    await expect(page.getByTestId('thread-stack-open')).toContainText('earlier in this thread');

    if (!agentOnly) {
      await api.delete(`/api/v1/graph/data_source/${sourceId}`);
      created.splice(created.indexOf(sourceId), 1);
    }
  });
}
