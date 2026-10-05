/**
 * Threads on Flowpad's own chat, between two users on two instances — the runbook is `native_threads.md`.
 *
 * A (THREADS_A_* ports) starts a conversation with B (THREADS_B_*) through the hub. B answers A's
 * message with Reply; A sees the thread pack, opens it, and sees the quote; A writes into the open
 * thread; B sees the thread grow and A's message unquoted. Both sides are sender AND receiver.
 * The hub must mirror `reply_to_id` / `thread_root_id` (FlowPad 9e28d65fc).
 */
import { expect, request, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';

const A = {
  ui: `http://localhost:${process.env.THREADS_A_UI || '5022'}`,
  api: `http://localhost:${process.env.THREADS_A_API || '6022'}`,
};
const B = {
  ui: `http://localhost:${process.env.THREADS_B_UI || '5023'}`,
  api: `http://localhost:${process.env.THREADS_B_API || '6023'}`,
  email: process.env.THREADS_B_EMAIL || 'thr-7@local.test',
};

let apiA: APIRequestContext;
let apiB: APIRequestContext;
let conversationId = '';
let rootId = '';
const nonce = Math.random().toString(36).slice(2, 8);

async function call<T = Record<string, unknown>>(api: APIRequestContext, method: 'get' | 'post', route: string, data?: unknown): Promise<T> {
  const res = await api[method](`/api/v1${route}`, data === undefined ? undefined : { data });
  const json = await res.json();
  expect(res.ok() && json.status === 'SUCCESS', `${method} ${route}: ${JSON.stringify(json).slice(0, 300)}`).toBeTruthy();
  return json.data as T;
}

async function page(browser: Browser, ui: string): Promise<Page> {
  const ctx = await browser.newContext({ baseURL: ui });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('llm-setup-modal-seen', 'true');
    } catch {
      /* sandboxed frame */
    }
  });
  return ctx.newPage();
}

const bubble = (p: Page, text: string) => p.locator('[data-testid^="message-bubble-"]', { hasText: text }).first();

async function openConversation(p: Page) {
  // From the base stream inbox: Flowpad's own chat is listed there beside every channel's.
  await p.goto('/dock/stream_inbox');
  const row = p.getByTestId('stream-inbox-conversation-row').filter({ hasText: nonce }).first();
  await expect(row, 'the conversation is not listed in the stream inbox').toBeVisible({ timeout: 20_000 });
  await row.click();
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(90_000);
  apiA = await request.newContext({ baseURL: A.api });
  apiB = await request.newContext({ baseURL: B.api });
  const projects = await call<Array<{ id: string; uname?: string }>>(apiA, 'get', '/graph/project');
  const project = projects.find((p) => p.uname === 'local')?.id;
  const conv = await call<{ conversation_id: string }>(apiA, 'post', '/graph/conversation-create', {
    project_id: project,
    title: `threads ${nonce}`,
    participants: [{ email: B.email }],
  });
  conversationId = conv.conversation_id;
  await call(apiA, 'post', `/graph/conversation/${conversationId}/share`, { recipients: [B.email] });
  const root = await call<{ flow_message_id: string }>(apiA, 'post', `/graph/conversation/${conversationId}/add_message`, {
    text: `root ${nonce}`,
  });
  rootId = root.flow_message_id;
  // B's machine has the conversation and the root.
  await expect
    .poll(
      async () => {
        await call(apiB, 'post', '/graph/conversation-list', {});
        const res = await apiB.post('/api/v1/graph/conversation-transcript', { data: { conversation_id: conversationId } });
        const json = await res.json();
        return (json.data?.messages ?? []).map((m: { id: string }) => m.id);
      },
      { timeout: 30_000, message: "B never received A's root" },
    )
    .toContain(rootId);
});

test.afterAll(async () => {
  await apiA?.dispose();
  await apiB?.dispose();
});

test("B answers A's message with Reply; A sees the thread and the quote; A writes into it; B sees it grow", async ({ browser }) => {
  test.setTimeout(120_000);
  const shots = process.env.SHOT_DIR;
  const b = await page(browser, B.ui);
  const a = await page(browser, A.ui);

  // ── B: Reply on A's root (receiver of the root, sender of the reply) ──
  await openConversation(b);
  await expect(bubble(b, `root ${nonce}`)).toBeVisible();
  await bubble(b, `root ${nonce}`).getByTestId('message-actions-menu').click();
  await b.getByTestId('message-reply').click();
  await expect(b.getByTestId('composer-reply-banner')).toContainText(`root ${nonce}`);
  await b.getByRole('textbox').last().fill(`which home ${nonce}?`);
  await b.locator('button[title="Send"]:not([data-testid])').click();
  // B's own view: the root and its reply pack into one thread.
  await expect(b.getByTestId('thread-stack-open')).toContainText('1 earlier in this thread', { timeout: 20_000 });
  if (shots) await b.screenshot({ path: `${shots}/native-1-b-replied.png`, fullPage: true });

  // ── A: the reply arrives packed with the root; the thread opens by URL, the quote names the root ──
  await openConversation(a);
  await expect(a.getByTestId('thread-stack-open')).toContainText('1 earlier in this thread', { timeout: 30_000 });
  await a.getByTestId('thread-stack-open').click();
  await expect(a).toHaveURL(/[?&]thread=/);
  await expect(a.getByTestId('thread-header-title')).toContainText(`root ${nonce}`);
  await expect(a.getByTestId('thread-header-count')).toContainText('2 messages');
  await expect(a.getByTestId('message-quote').filter({ hasText: `root ${nonce}` })).toBeVisible();
  if (shots) await a.screenshot({ path: `${shots}/native-2-a-thread.png`, fullPage: true });

  // ── A: write into the open thread (no quote) ──
  await expect(a.getByTestId('composer-thread-banner')).toContainText(`root ${nonce}`);
  await a.getByRole('textbox').last().fill(`43 ${nonce}`);
  await a.locator('button[title="Send"]:not([data-testid])').click();
  await expect(a.getByTestId('thread-header-count')).toContainText('3 messages', { timeout: 20_000 });
  await expect(bubble(a, `43 ${nonce}`).getByTestId('message-quote')).toHaveCount(0);

  // ── B: the thread grew to three; A's message is in it, unquoted ──
  await expect(b.getByTestId('thread-stack-open')).toContainText('2 earlier in this thread', { timeout: 30_000 });
  await b.getByTestId('thread-stack-open').click();
  await expect(b.getByTestId('thread-header-count')).toContainText('3 messages');
  await expect(bubble(b, `43 ${nonce}`)).toBeVisible();
  await expect(bubble(b, `43 ${nonce}`).getByTestId('message-quote')).toHaveCount(0);
  await expect(b.getByTestId('message-quote').filter({ hasText: `root ${nonce}` })).toBeVisible();
  if (shots) await b.screenshot({ path: `${shots}/native-3-b-thread.png`, fullPage: true });

  // Back to every message on both.
  for (const p of [a, b]) {
    await p.getByTestId('thread-header-all').click();
    await expect(p).not.toHaveURL(/[?&]thread=/);
    await expect(p.getByTestId('thread-stack-open')).toContainText('2 earlier in this thread');
  }
});
