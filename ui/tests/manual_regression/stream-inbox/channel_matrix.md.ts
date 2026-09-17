/**
 * Stream inbox channel matrix — owner (user | agent) × channel (gmail, slack, whatsapp, telegram,
 * agent email), in the browser. The runbook is `channel_matrix.md`; each `test N` here is one cell.
 *
 * Providers are loopback doubles hosted by `tests/e2e/channel_doubles.py` (spawned here under the
 * instance's FLOW_INSTANCE); the backend talks to them exactly as it would to the real hosts. The
 * agent's email is a real hub mailbox on the local hub's in-process provider.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { REPO_ROOT, apiContext, apiOrigin, configuredFileEnv } from '../_shared/api';

const INSTANCE = process.env.FLOW_INSTANCE || '';

const CHANNELS = ['gmail', 'slack', 'whatsapp', 'telegram', 'cloud_email'] as const;
type Channel = (typeof CHANNELS)[number];
const OWNERS = ['user', 'agent'] as const;
type Owner = (typeof OWNERS)[number];
/** An agent email address is an agent's by definition: there is no user-owned cell. Playwright
 *  builds its test list at load time, before the doubles can say so (`agent_only` on `/channels`),
 *  hence the table. */
const NOT_APPLICABLE: Array<[Owner, Channel]> = [['user', 'cloud_email']];

interface ChannelEntry {
  config: Record<string, unknown>;
  fields?: Record<string, unknown>;
  secret_store?: { type: string; config: Record<string, unknown> };
  sender: string;
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

async function graph<T = Record<string, unknown>>(method: 'get' | 'post' | 'delete', route: string, data?: unknown): Promise<T> {
  const res = await api[method](`/api/v1${route}`, data === undefined ? undefined : { data });
  const json = await res.json();
  expect(res.ok() && json.status === 'SUCCESS', `${method} ${route}: ${JSON.stringify(json).slice(0, 300)}`).toBeTruthy();
  return json.data as T;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  api = await apiContext();

  const users = await graph<Array<{ id: string; uname?: string }>>('get', '/graph/user');
  localUserId = users.find((u) => u.uname === 'local')?.id ?? '';
  expect(localUserId, 'no local user row').toBeTruthy();

  // The doubles: one process, every driver's Double, credentials planted on this instance.
  doubles = spawn('uv', ['run', 'python', 'tests/e2e/channel_doubles.py', '--backend', apiOrigin()], {
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

  // The agent, its mailbox (born owned by the agent), and the outsider that writes to it.
  const agent = await graph<{ id: string }>('post', '/graph/agent', {
    name: `matrix agent ${Date.now().toString(36)}`,
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
  for (const channel of CHANNELS) expect(channels[channel], `the doubles host no ${channel}`).toBeTruthy();
});

test.afterAll(async () => {
  for (const id of created) await api.delete(`/api/v1/graph/data_source/${id}`);
  if (agentId) await api.delete(`/api/v1/graph/agent/${agentId}`);
  // `/shutdown` makes the doubles remove what they planted and release the outsider's mailbox;
  // wait for the process to finish that before anything could kill it.
  if (doubles && control) {
    const exited = new Promise<void>((resolve) => doubles!.once('exit', () => resolve()));
    await api.post(`${control}/shutdown`).catch(() => undefined);
    await exited;
  }
  doubles?.kill();
  await api.dispose();
});

function ownerKey(owner: Owner): string {
  return owner === 'user' ? `user-${localUserId}` : `agent-${agentId}`;
}

function streamInboxPath(owner: Owner): string {
  return owner === 'user' ? '/dock/stream_inbox' : `/dock/agent/${agentId}/stream_inbox`;
}

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

/** The cell's source: the agent's own mailbox row for agent email, else a fresh row for the owner. */
async function sourceFor(owner: Owner, channel: Channel): Promise<string> {
  if (channel === 'cloud_email') return agentMailboxSourceId;
  const entry = channels[channel];
  const body: Record<string, unknown> = {
    name: `matrix ${owner} ${channel} ${Date.now().toString(36)}`,
    provider: channel,
    config: entry.config,
    owner: ownerKey(owner),
    // An agent cell must not spawn a real worker turn: the runner refuses a stranger and the
    // projection still lands. The reply below is the composer's, sent as the agent.
    inbound_allowed_senders: [],
    ...(entry.fields ?? {}),
  };
  if (entry.secret_store) body.secret_store = entry.secret_store;
  const source = await graph<{ id: string }>('post', '/graph/data_source', body);
  created.push(source.id);
  await graph('post', `/graph/data_source/${source.id}/verify`, {});
  return source.id;
}

async function deliverAndSync(channel: Channel, sourceId: string, nonce: string) {
  await controlJson('POST', '/deliver', { channel, text: `hello ${nonce}` });
  const report = await graph<{ health?: string; error_detail?: string }>('post', `/graph/data_source/${sourceId}/sync`, {});
  expect(report.health, `${channel}: sync ${report.error_detail ?? ''}`).toBe('ok');
}

let cell = 0;
for (const owner of OWNERS) {
  for (const channel of CHANNELS) {
    const na = NOT_APPLICABLE.some(([o, c]) => o === owner && c === channel);
    cell += na ? 0 : 1;
    const title = na ? `n/a. ${owner} × ${channel}` : `${cell}. ${owner} × ${channel}`;
    test(title, async ({ page }) => {
      test.skip(na, 'an agent email address is an agent\'s by definition; a user has no cloud_email source');
      const nonce = Math.random().toString(36).slice(2, 8);
      const sourceId = await sourceFor(owner, channel);
      await deliverAndSync(channel, sourceId, nonce);
      const other: Owner = owner === 'user' ? 'agent' : 'user';

      // The owner's stream inbox: the row, its chip, the bar's mark.
      await open(page, streamInboxPath(owner));
      const row = page.getByTestId('stream-inbox-conversation-row').filter({ hasText: nonce });
      await expect(row).toHaveCount(1);
      // The chip wears the CHANNEL's title (a mailbox is "Email" whichever driver reads it), which the
      // conversation declares as its channel spec.
      const conversationId = (await row.getAttribute('data-conversation-id')) ?? '';
      const conversation = await graph<{ channel_spec?: { title?: string } }>('get', `/graph/conversation/${conversationId}`);
      const channelTitle = conversation.channel_spec?.title ?? '';
      expect(channelTitle, 'the conversation declares no channel title').toBeTruthy();
      await expect(row.locator('[data-chip-type="source"]').first()).toHaveAttribute('title', channelTitle);
      const bar = page.getByTestId('attached-channels');
      await expect(bar).toHaveAttribute('data-owner', ownerKey(owner));
      await expect(bar.locator(`[data-testid="attached-channel"][data-provider="${channel}"]`)).toHaveCount(1);

      // Reply from the composer, in the channel.
      await row.click();
      const composer = page.getByPlaceholder(`Reply in ${channelTitle}`);
      await expect(composer).toBeVisible();
      await composer.fill(`reply ${nonce}`);
      // The composer's own Send (the entity-execution bar has another, `data-testid=entity-execution-send`).
      await page.locator('button[title="Send"]:not([data-testid])').click();

      await expect
        .poll(async () => {
          const sent = await controlJson<Array<{ text?: string }>>('GET', `/sent?channel=${channel}`);
          return sent.some((m) => (m.text ?? '').includes(`reply ${nonce}`));
        }, { message: `${channel}: the reply never left through the double` })
        .toBe(true);

      // Nobody else's.
      await open(page, streamInboxPath(other));
      await expect(page.getByTestId('stream-inbox-conversation-row').filter({ hasText: nonce })).toHaveCount(0);

      // The cell's source goes now: the doubles are one account per channel, and a delivery is
      // routed to the source watching that account — the next owner's cell must be the only one.
      if (channel !== 'cloud_email') {
        await api.delete(`/api/v1/graph/data_source/${sourceId}`);
        created.splice(created.indexOf(sourceId), 1);
      }
    });
  }
}
