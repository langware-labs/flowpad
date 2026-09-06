/** Shared setup for the live-session specs: a fresh conversation between
 * alice (GUEST) and bob (HOST) whose host side is project-mapped. */
import { expect, type Browser, type Page } from '@playwright/test';

import { ALICE, BOB, gotoConversation, openInstance, startConversationViaUi } from './helpers';

export const BOB_EMAIL = process.env.BOB_CLOUD_EMAIL || 'bob@local.test';
export const HOST_PROJECT_ID = process.env.HOST_PROJECT_ID || '';
export const SCREENSHOT_DIR = process.env.LIVE_SESSION_SHOTS || '';

export function sessionCards(page: Page) {
  return page.locator('[data-testid="session-card"]');
}

/** Same write the host's project picker performs: ``conv.project_id = X; conv.save()``. */
export async function mapHostConversation(convId: string) {
  const url = `${BOB.backendUrl}/api/v1/graph/conversation/${convId}`;
  let conv: Record<string, unknown> | null = null;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const r = await fetch(url);
    if (r.ok) {
      const body = (await r.json()) as { data?: Record<string, unknown> };
      if (body.data?.id) { conv = body.data; break; }
    }
    await new Promise((res) => setTimeout(res, 200));
  }
  if (!conv) throw new Error(`bob never materialized conversation ${convId}`);
  const r = await fetch(url, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...conv, project_id: HOST_PROJECT_ID }),
  });
  if (!r.ok) throw new Error(`mapping bob's conversation failed: ${r.status} ${await r.text()}`);
}

export async function setupLiveConversation(browser: Browser) {
  const alice = await openInstance(browser, ALICE);
  const bob = await openInstance(browser, BOB);
  const convId = await startConversationViaUi(alice.page, BOB_EMAIL, `live-setup-${Date.now()}`);
  await mapHostConversation(convId);
  await gotoConversation(bob.page, convId);
  await gotoConversation(alice.page, convId);
  return { alice, bob, convId };
}

/** Open a session from the conversation composer (alice's side). */
export async function sendOpeningPrompt(page: Page, text: string) {
  const toggle = page.getByTestId('composer-session-toggle');
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
  const ta = page.locator('textarea[placeholder^="Prompt to run on"]');
  await ta.fill(text);
  const sendBtn = page.locator('button[title="Send"]:not([data-testid])');
  await expect(sendBtn).toBeEnabled({ timeout: 1_000 });
  await ta.press('Enter'); // Enter submits; a toast over the Send button cannot intercept it
}

/** Log and dismiss any toast: it overlays the composer and would swallow the click. */
export async function dismissToasts(page: Page, who: string) {
  const toasts = page.locator('section[aria-label^="Notifications"] [data-sonner-toast], section[aria-label^="Notifications"] li');
  const n = await toasts.count();
  if (!n) return;
  console.log(`[toast:${who}]`, JSON.stringify((await toasts.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').slice(0, 160))));
  for (let i = 0; i < n; i++) {
    const close = toasts.nth(0).locator('button[aria-label="Close toast"], button[data-close-button]');
    if (await close.count()) await close.first().click().catch(() => undefined);
    else await page.keyboard.press('Escape');
  }
  await expect(toasts).toHaveCount(0, { timeout: 3_000 }).catch(() => undefined);
}

/** Type a follow-up inside the session view. */
export async function sendFollowUp(page: Page, text: string) {
  const view = page.getByTestId('live-session-view');
  const ta = view.locator('textarea');
  await ta.fill(text);
  const sendBtn = view.locator('button[title="Send"]:not([data-testid])');
  await expect(sendBtn).toBeEnabled({ timeout: 1_000 });
  // Enter submits the composer (MessageComposer.handleKeyDown) and cannot be
  // intercepted by a toast landing over the Send button mid-run.
  await ta.press('Enter');
}

export async function shot(page: Page, name: string) {
  if (!SCREENSHOT_DIR) return;
  await page.screenshot({ path: `${SCREENSHOT_DIR}/${name}.png`, fullPage: false });
}

/** Alice's cloud user id as bob's backend knows it (the key of a standing grant). */
export async function aliceCloudId(): Promise<string> {
  const status = await fetch(`${ALICE.backendUrl}/api/v1/cloud/status`).then((r) => r.json());
  const id = status?.data?.login?.user?.id ?? status?.data?.user?.id;
  if (!id) throw new Error('could not read alice cloud user id');
  return id as string;
}

/** Remove every standing grant bob holds for alice — a spec that ticks the
 * checkbox must leave the host as it found it, or the next spec's new session
 * skips PENDING and its Approve step never appears. */
export async function revokeAliceGrantsOnBob(): Promise<number> {
  const id = await aliceCloudId().catch(() => null);
  const rows = await fetch(`${BOB.backendUrl}/api/v1/graph/contact_permission`).then((r) => r.json()).catch(() => null);
  const mine = ((rows?.data ?? []) as Array<Record<string, unknown>>).filter((r) => !id || r.contact_user_id === id);
  for (const r of mine) await fetch(`${BOB.backendUrl}/api/v1/graph/contact_permission/${String(r.id)}`, { method: 'DELETE' }).catch(() => undefined);
  return mine.length;
}

