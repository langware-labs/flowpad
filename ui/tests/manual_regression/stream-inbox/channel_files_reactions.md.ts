/**
 * Channel files, quotes and reactions in the browser — the runbook is `channel_files_reactions.md`.
 * Providers are the loopback doubles `tests/e2e/channel_doubles.py` hosts (spawned here under the
 * instance's FLOW_INSTANCE); the backend talks to them exactly as it would to the real hosts.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { REPO_ROOT, apiContext, apiOrigin, configuredFileEnv } from '../_shared/api';

const INSTANCE = process.env.FLOW_INSTANCE || '';
const CHANNELS = ['whatsapp', 'telegram'] as const;
type Channel = (typeof CHANNELS)[number];

// A real 2×2 PNG, so the browser decodes it (naturalWidth > 0) — a stub would render a broken image.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==';

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

  doubles = spawn('uv', ['run', 'python', 'tests/e2e/channel_doubles.py', '--backend', apiOrigin(), '--channels', CHANNELS.join(',')], {
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
});

test.afterAll(async () => {
  for (const id of created) await api.delete(`/api/v1/graph/data_source/${id}`);
  if (doubles && control) {
    const exited = new Promise<void>((resolve) => doubles!.once('exit', () => resolve()));
    await api.post(`${control}/shutdown`).catch(() => undefined);
    await exited;
  }
  doubles?.kill();
  await api.dispose();
});

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

async function sourceFor(channel: Channel): Promise<string> {
  const entry = channels[channel];
  const body: Record<string, unknown> = {
    name: `files ${channel} ${Date.now().toString(36)}`,
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

CHANNELS.forEach((channel, i) => {
  test(`${i + 1}. ${channel}: a photo, a quote, reactions both ways, a reply with a file`, async ({ page }) => {
    const nonce = Math.random().toString(36).slice(2, 8);
    const sourceId = await sourceFor(channel);

    // The person sends a photo, then quotes it.
    const photo = await controlJson<{ external_id: string; thread?: string }>('POST', '/deliver', {
      channel,
      text: `photo ${nonce}`,
      files: [{ name: `crack-${nonce}.png`, media_type: 'image/png', as_: 'image', b64: PNG_B64, caption: `photo ${nonce}` }],
    });
    await sync(sourceId);
    await controlJson('POST', '/deliver', { channel, text: `is it bad ${nonce}?`, reply_to: photo.external_id, thread: photo.thread });
    await sync(sourceId);

    await open(page, '/dock/stream_inbox');
    // The newest conversation is this cell's (its source was made for it); the thread inside names the nonce.
    const row = page.getByTestId('stream-inbox-conversation-row').first();
    await expect(row).toBeVisible();
    await row.click();
    await expect(page.getByText(`is it bad ${nonce}?`)).toBeVisible();
    // A thread shows its newest message; the photo is the one before it. Both were delivered on one
    // thread, so the stack is always there — but only once both messages have hydrated: until then the
    // feed lays them out flat and folds them a beat later. An instant `isVisible()` probe raced that
    // fold, skipped the click, and the photo then folded away under the next assertion.
    await page.getByRole('button', { name: /earlier in this thread/ }).click();

    // The picture itself, decoded — its bytes were copied while the provider's session was open.
    // (WhatsApp names no photo, so the bubble is found by its caption — the message's words.)
    const photoBubble = page
      .locator('[data-testid^="message-bubble-"]')
      .filter({ hasText: `photo ${nonce}` })
      .filter({ has: page.locator('img') })
      .first();
    const img = photoBubble.locator('img').first();
    await expect(img).toBeVisible();
    await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

    // The quote block on the reply names the photo's words.
    const quote = page.getByTestId('message-quote').filter({ hasText: `photo ${nonce}` });
    await expect(quote).toBeVisible();

    // We react from the photo's bubble — React is in its ⋮ menu (the menu portals out of the bubble).
    await photoBubble.getByTestId('message-actions-menu').click();
    await page.getByTestId('message-react').click();
    await page.getByRole('option', { name: 'thumbs up yes approve like' }).click();
    await expect(photoBubble.getByTestId('reaction-👍')).toHaveAttribute('aria-pressed', 'true');
    await expect
      .poll(async () => JSON.stringify(await controlJson('GET', `/reactions?channel=${channel}`)), {
        message: `${channel}: our 👍 never reached the double`,
      })
      .toContain('👍');

    // The person reacts back.
    await controlJson('POST', '/react', { channel, target: photo.external_id, emoji: '❤️' });
    await sync(sourceId);
    await expect(photoBubble.getByTestId('reaction-❤️')).toBeVisible();

    if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/${channel}-reactions.png`, fullPage: true });

    // We answer the photo with a file.
    await photoBubble.getByTestId('message-actions-menu').click();
    await page.getByTestId('message-reply').click();
    await expect(page.getByTestId('composer-reply-banner')).toContainText(`photo ${nonce}`);
    await expect(page.getByTestId('attach-file-button')).toBeEnabled();
    const chooser = page.waitForEvent('filechooser');
    await page.getByTestId('attach-file-button').click();
    await (await chooser).setFiles({
      name: `answer-${nonce}.png`,
      mimeType: 'image/png',
      buffer: Buffer.from(PNG_B64, 'base64'),
    });
    // An image passes the annotator first (the composer's own step); attach it as is.
    await page.getByRole('dialog', { name: 'Annotate image' }).getByRole('button', { name: 'Attach' }).click();
    await expect(page.getByText(`answer-${nonce}.png`)).toBeVisible();
    const composer = page.getByPlaceholder(/^Reply in /);
    await composer.fill(`see ${nonce}`);
    if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/${channel}-reply.png`, fullPage: true });
    await page.locator('button[title="Send"]:not([data-testid])').click();
    await expect
      .poll(
        async () => JSON.stringify(await controlJson('GET', `/sent?channel=${channel}`)),
        { message: `${channel}: the reply with its file never left through the double` },
      )
      .toContain(`answer-${nonce}.png`);
    const sent = await controlJson<Array<Record<string, unknown>>>('GET', `/sent?channel=${channel}`);
    const withFile = sent.find((m) => JSON.stringify(m).includes(`answer-${nonce}.png`)) ?? {};
    expect(JSON.stringify(withFile), 'the reply quotes the photo').toContain(photo.external_id.split('/').pop() ?? photo.external_id);

    // Our reply lands in the conversation with its picture (the sent copy keeps its own durable file).
    const ours = page.locator(`img[alt="answer-${nonce}.png"]`);
    await expect(ours).toBeVisible();
    await expect.poll(() => ours.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/${channel}-sent.png`, fullPage: true });

    await api.delete(`/api/v1/graph/data_source/${sourceId}`);
    created.splice(created.indexOf(sourceId), 1);
  });
});
