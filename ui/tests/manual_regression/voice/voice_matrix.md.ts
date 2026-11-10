/**
 * Voice matrix in the browser — an agent's three voice channels, each started from the agent's
 * stream inbox, each watched LIVE in the conversation while it happens. The runbook is
 * `voice_matrix.md`.
 *
 * Real end to end: OpenAI Realtime carries the audio (browser WebRTC; Twilio → SIP for the phone),
 * OpenAI transcribes and speaks the sound files, and the agent is a real worker answering from facts
 * only it holds — so a spoken answer that names them proves the voice delegated to the agent.
 *
 *   1. sound file — a recorded question in, a spoken reply clip out
 *   2. browser mic + speakers — Chromium's microphone plays VOICE_MIC_WAV (the question after a pause
 *      for the voice's greeting); the voice is heard back (inbound RTP bytes on the peer)
 *   3. phone (Twilio) — the agent dials VOICE_PHONE_TO; a person on the line asks the question
 *
 * "Live" is asserted, not assumed: a watcher samples the open conversation while the call runs and
 * must see the agent working (the activity line) and — on a live line — the caller's sentence
 * forming (`voice-partial`) BEFORE the answer lands.
 *
 * Env: FLOW_INSTANCE, VOICE_CLIP_WAV (the recorded question), VOICE_MIC_WAV; for the phone VOICE_PHONE_TO, VOICE_PHONE_NUMBER,
 * VOICE_OPENAI_PROJECT.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { apiContext } from '../_shared/api';

const CLIP = process.env.VOICE_CLIP_WAV || '';
/** The microphone's recording: the question after a pause long enough for the voice's greeting. */
const MIC = process.env.VOICE_MIC_WAV || '';
const PHONE_TO = process.env.VOICE_PHONE_TO || '';
const PHONE_NUMBER = process.env.VOICE_PHONE_NUMBER || '';
const PHONE_PROJECT = process.env.VOICE_OPENAI_PROJECT || '';
/** What only the agent knows — the answer to the recorded question must come from here. */
const FACTS = "Today's plan: standup at 10:00, the design review at 14:00. The release codename is Blue Heron.";
/** The design review is at 14:00 — however the voice phrases it. Never a bare digit: the page's own
 *  clock stamps ("3:22 PM") must not read as the answer. */
const ANSWERED = /\b(2|two)(:00)?\s*(pm|p\.m\.|o'clock|in the afternoon)|\b14:00\b|fourteen hundred/i;

let api: APIRequestContext;
let agentId = '';
const lines: Record<string, string> = {};

async function graph<T = Record<string, unknown>>(method: 'get' | 'post' | 'delete', route: string, data?: unknown): Promise<T> {
  const res = await api[method](`/api/v1${route}`, data === undefined ? undefined : { data });
  const json = await res.json();
  expect(res.ok() && json.status === 'SUCCESS', `${method} ${route}: ${JSON.stringify(json).slice(0, 300)}`).toBeTruthy();
  return json.data as T;
}

async function line(provider: string, config: Record<string, unknown>, allowed: string[] = []): Promise<string> {
  const source = await graph<{ id: string; channel: string }>('post', '/graph/data_source', {
    name: `voice matrix ${provider} ${Date.now().toString(36)}`,
    provider,
    config,
    owner: `agent-${agentId}`,
    inbound_allowed_senders: allowed,
  });
  expect(source.channel, `${provider} is not on channel voice`).toBe('voice');
  return source.id;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  api = await apiContext();
  const agent = await graph<{ id: string }>('post', '/graph/agent', {
    name: `Voice matrix ${Date.now().toString(36)}`,
    worker_type: 'claude',
    system_prompt: `You are the team assistant. ${FACTS} Answer in one or two short sentences.`,
  });
  agentId = agent.id;
  lines.clip = await line('voice_file', { folder: `/tmp/voice-matrix-${agentId}` });
  lines.webrtc = await line('voice_browser', { room: `desk-${agentId.slice(0, 6)}` });
  if (PHONE_TO) lines.dial = await line('voice_phone', { number: PHONE_NUMBER, project: PHONE_PROJECT }, [PHONE_TO]);
});

test.afterAll(async () => {
  for (const id of Object.values(lines)) await api.delete(`/api/v1/graph/data_source/${id}`);
  if (agentId) await api.delete(`/api/v1/graph/agent/${agentId}`);
});

async function openStreamInbox(page: Page) {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('llm-setup-modal-seen', 'true');
    } catch {
      /* sandboxed frame */
    }
  });
  await page.goto(`/dock/agent/${agentId}/stream_inbox`);
  await expect(page.getByTestId('attached-channels')).toBeVisible();
}

async function rowIds(page: Page): Promise<string[]> {
  return page.getByTestId('stream-inbox-conversation-row').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-conversation-id') ?? ''));
}

/** The conversation a call just made: the row that was not there before it started. */
async function openNewConversation(page: Page, before: string[]) {
  let fresh = '';
  await expect
    .poll(async () => {
      fresh = (await rowIds(page)).find((id) => id && !before.includes(id)) ?? '';
      return fresh;
    }, { message: 'the call never became a conversation in the stream inbox' })
    .not.toBe('');
  await page.locator(`[data-testid="stream-inbox-conversation-row"][data-conversation-id="${fresh}"]`).click();
  return fresh;
}

interface Moment {
  at: number;
  working: boolean;
  partial: string;
  text: string;
}

/** Sample the open conversation until `done` says the call is over; the timeline is the evidence. */
async function watch(page: Page, done: (m: Moment) => boolean, budgetMs: number): Promise<Moment[]> {
  const start = Date.now();
  const timeline: Moment[] = [];
  let unpacked = false;
  while (Date.now() - start < budgetMs) {
    // A call is one thread, packed to its newest sentence: open the thread once it has a stack, so
    // every sentence shows as it lands.
    if (!unpacked && (await page.getByTestId('thread-stack-open').count())) {
      await page.getByTestId('thread-stack-open').first().click();
      unpacked = true;
    }
    // One read of the page as it is NOW — a locator read would wait for an element that is not there.
    const now = await page.evaluate(() => {
      const byId = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
      const line = byId('chat-activity-line');
      return { working: !!line && line.offsetParent !== null, partial: byId('voice-partial')?.innerText ?? '', text: document.body.innerText };
    });
    const moment: Moment = { at: Date.now() - start, ...now };
    timeline.push(moment);
    if (done(moment)) return timeline;
    await page.waitForTimeout(250);
  }
  return timeline;
}

const firstAt = (timeline: Moment[], pick: (m: Moment) => boolean) => timeline.find(pick)?.at ?? Infinity;

test('1. sound file — a recorded question in, the agent answers as a spoken clip, live in the conversation', async ({ page }) => {
  test.skip(!CLIP || !existsSync(CLIP), 'VOICE_CLIP_WAV names no recording');
  await openStreamInbox(page);
  const before = await rowIds(page);
  await page.locator('[data-testid="voice-call-button"][data-calls="clip"]').click();
  await page.getByTestId('voice-clip-input').setInputFiles(CLIP);
  await expect(page.getByTestId('voice-call-status')).toHaveAttribute('data-ok', 'true');
  await page.keyboard.press('Escape');

  await openNewConversation(page, before);
  const timeline = await watch(page, (m) => /Call ended/.test(m.text), 90_000);
  const last = timeline.at(-1)!;
  expect(last.text, 'the recording was never heard').toMatch(/design review/i);
  expect(last.text, "the answer is not the agent's").toMatch(ANSWERED);
  expect(last.text).toMatch(/Call ended/);
  const answeredAt = firstAt(timeline, (m) => ANSWERED.test(m.text.split(/design review/i).slice(1).join(' ')));
  expect(firstAt(timeline, (m) => m.working), 'the agent was never seen working while the call ran').toBeLessThan(answeredAt);

  // The reply is a sound file: the agent's sentence carries the clip it was spoken into.
  const listed = await graph<{ items: Array<{ id: string }> }>('post', `/graph/data_source/${lines.clip}/items`, { limit: 20 });
  const clips: string[] = [];
  for (const { id } of listed.items) {
    const item = await graph<{ data?: { attachments?: Array<{ data?: { path?: string } }> } }>('get', `/graph/source_item/${id}`);
    clips.push(...(item.data?.attachments ?? []).map((a) => a.data?.path ?? ''));
  }
  expect(clips.some((p) => /-reply\.mp3$/.test(p) && existsSync(p)), `no reply clip on disk: ${clips.join(', ')}`).toBe(true);
});

test('2. browser mic + speakers — a live call the agent answers, heard back, watched as it happens', async ({ page }) => {
  test.skip(!MIC || !existsSync(MIC), 'VOICE_MIC_WAV plays no question into the microphone');
  await page.addInitScript(() => {
    // Keep every peer the page makes, so the test can ask what went out and what came back.
    const Native = window.RTCPeerConnection;
    const peers: RTCPeerConnection[] = [];
    (window as unknown as { __peers: RTCPeerConnection[] }).__peers = peers;
    window.RTCPeerConnection = class extends Native {
      constructor(...args: ConstructorParameters<typeof RTCPeerConnection>) {
        super(...args);
        peers.push(this);
      }
    } as typeof RTCPeerConnection;
  });
  await openStreamInbox(page);
  const before = await rowIds(page);
  await page.locator('[data-testid="voice-call-button"][data-calls="webrtc"]').click();
  await page.getByTestId('voice-call-start').click();
  await expect(page.getByTestId('voice-call-state')).toHaveAttribute('data-state', 'live', { timeout: 30_000 });
  await page.keyboard.press('Escape');

  await openNewConversation(page, before);
  // The voice speaks first; the person (Chromium's microphone playing VOICE_MIC_WAV, whose question
  // starts after a pause) answers the greeting.
  const greeted = await watch(page, (m) => /help/i.test(m.text.split(/Call with/).slice(1).join(' ')), 30_000);
  expect(greeted.at(-1)!.text, 'the voice never greeted the caller').toMatch(/help/i);

  const timeline = await watch(page, (m) => ANSWERED.test(m.text.split(/design review/i).slice(1).join(' ')), 90_000);
  // The microphone carried the question: sound energy left through the peer.
  const spoken = await page.evaluate(async () => {
    let energy = 0;
    for (const peer of (window as unknown as { __peers: RTCPeerConnection[] }).__peers) {
      (await peer.getStats()).forEach((r) => {
        if (r.type === 'media-source' && r.kind === 'audio') energy += r.totalAudioEnergy ?? 0;
      });
    }
    return energy;
  });
  expect(spoken, 'the microphone sent silence').toBeGreaterThan(0);
  const last = timeline.at(-1)!;
  expect(last.text, 'the question on the microphone was never heard').toMatch(/design review/i);
  expect(last.text, "the answer is not the agent's").toMatch(ANSWERED);
  const answeredAt = firstAt(timeline, (m) => ANSWERED.test(m.text.split(/design review/i).slice(1).join(' ')));
  expect(firstAt(timeline, (m) => !!m.partial), "the caller's sentence was never seen forming").toBeLessThan(answeredAt);
  expect(firstAt(timeline, (m) => m.working), 'the agent was never seen working while the call ran').toBeLessThan(answeredAt);

  // The speakers: the provider's voice arrived as audio on the peer.
  const heard = await page.evaluate(async () => {
    const peers = (window as unknown as { __peers: RTCPeerConnection[] }).__peers;
    let bytes = 0;
    for (const peer of peers) {
      (await peer.getStats()).forEach((report) => {
        if (report.type === 'inbound-rtp' && report.kind === 'audio') bytes += report.bytesReceived ?? 0;
      });
    }
    return bytes;
  });
  expect(heard, 'no audio reached the speakers').toBeGreaterThan(1000);

  // Back to the stream inbox — in-app, no reload: the call is still up — and hang up from there.
  const conversationUrl = page.url();
  await page.getByRole('navigation', { name: 'breadcrumb' }).getByText('Stream Inbox').click();
  await expect(page.getByTestId('attached-channels')).toBeVisible();
  await page.locator('[data-testid="voice-call-button"][data-calls="webrtc"]').click();
  await expect(page.getByTestId('voice-call-state'), 'the call did not survive leaving its control').toHaveAttribute('data-state', 'live');
  await page.getByTestId('voice-call-end').click();
  await expect(page.getByTestId('voice-call-state')).toHaveAttribute('data-state', 'ended');
  await page.keyboard.press('Escape');
  await page.goto(conversationUrl);
  const unpack = page.getByTestId('thread-stack-open');
  if (await unpack.count()) await unpack.first().click();
  await expect(page.locator('body')).toContainText('Call ended', { timeout: 30_000 });
});

test('3. phone (Twilio) — the agent calls a person, who asks it on the line; watched live', async ({ page }) => {
  test.skip(!PHONE_TO || !PHONE_NUMBER || !PHONE_PROJECT, 'VOICE_PHONE_TO / VOICE_PHONE_NUMBER / VOICE_OPENAI_PROJECT not set');
  // A person answers, listens, asks and hangs up: the budget is a human conversation, set here once.
  test.setTimeout(300_000);
  await openStreamInbox(page);
  const before = await rowIds(page);
  await page.locator('[data-testid="voice-call-button"][data-calls="dial"]').click();
  await page.getByTestId('voice-dial-to').fill(PHONE_TO);
  await page.getByTestId('voice-dial-brief').fill('A quick check-in: ask them what they would like to know about today.');
  await page.getByTestId('voice-dial-call').click();
  await expect(page.getByTestId('voice-call-status')).toHaveAttribute('data-ok', 'true');
  await page.keyboard.press('Escape');

  await openNewConversation(page, before);
  const timeline = await watch(page, (m) => /Call ended/.test(m.text), 240_000);
  const last = timeline.at(-1)!;
  expect(last.text, 'the call never ended').toMatch(/Call ended/);
  // A person says what they say — the check is not a script. What must hold on any call: the caller
  // was heard as they spoke, the agent was seen working on what they asked, and the call kept going
  // after it — its answer was spoken into the line, not dropped under the voice's own words.
  expect(firstAt(timeline, (m) => !!m.partial), "the caller's words were never seen forming").toBeLessThan(Infinity);
  const workedAt = firstAt(timeline, (m) => m.working);
  expect(workedAt, 'the agent was never seen working on the call').toBeLessThan(Infinity);
  const whileWorking = timeline.find((m) => m.at === workedAt)!.text;
  const afterIdle = timeline.find((m) => m.at > workedAt && !m.working && m.text.length > whileWorking.length);
  expect(afterIdle, "nothing was said after the agent's turn — its answer never reached the line").toBeTruthy();
  // When the person asks the scripted question, the answer must be the agent's own fact.
  if (/design review/i.test(last.text)) {
    expect(last.text.split(/design review/i).slice(1).join(' '), "the agent's answer was never spoken").toMatch(ANSWERED);
  }
});
