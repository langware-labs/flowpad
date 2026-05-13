/**
 * Two-browser realtime conversation helpers.
 *
 * The flowpad-oss instance (alice, UI :4098, backend :9008) and the
 * flowpad-app instance (bob, UI :4097, backend :9007) each run their own
 * UI + local backend. Both backends must be cloud-logged-in to the local
 * hub at :8093 and both hub WS bridges must be connected before these
 * helpers can drive a hub-mirrored conversation.
 *
 * The bare selectors come from MessageBubble.tsx (`message-bubble-<id>`),
 * MessageComposer.tsx (Send button title="Send", reply textarea
 * placeholder="Reply to sender…"), NewConversationDialog.tsx (testids
 * `new-conversation-dialog`, `participant-input`, `initial-message-input`)
 * and the home-landing "Start conversation" button by text.
 */
import { type Browser, type BrowserContext, type Page, expect } from '@playwright/test';

export interface InstanceConfig {
  /** Display label used in console output, e.g. "alice". */
  name: string;
  /** UI dev-server origin, e.g. "http://localhost:4098". */
  uiUrl: string;
  /** Local backend HTTP origin, e.g. "http://localhost:9008". */
  backendUrl: string;
}

export const ALICE: InstanceConfig = {
  name: 'alice',
  uiUrl: process.env.ALICE_UI_URL || 'http://localhost:4098',
  backendUrl: process.env.ALICE_BACKEND_URL || 'http://localhost:9008',
};

export const BOB: InstanceConfig = {
  name: 'bob',
  uiUrl: process.env.BOB_UI_URL || 'http://localhost:4097',
  backendUrl: process.env.BOB_BACKEND_URL || 'http://localhost:9007',
};

export const HUB_URL = process.env.FLOWPAD_HUB_URL || 'http://localhost:8093';

/**
 * Hard preconditions: both backends must respond to /health, both must report
 * cloud-logged-in, and the local hub must be up. Each probe times out fast so
 * a missing service surfaces as a clear ~3s failure, not a hung test.
 */
export async function assertPreconditions() {
  const checks: Array<[string, string]> = [
    [`${HUB_URL}/api/v1/health/status`, 'hub'],
    [`${ALICE.backendUrl}/api/v1/health/status`, 'alice backend'],
    [`${BOB.backendUrl}/api/v1/health/status`, 'bob backend'],
  ];
  for (const [url, label] of checks) {
    const r = await fetch(url, { signal: AbortSignal.timeout(1500) }).catch((e) => {
      throw new Error(`${label} unreachable at ${url}: ${e}`);
    });
    if (!r.ok) throw new Error(`${label} /health returned ${r.status}`);
  }
  for (const inst of [ALICE, BOB]) {
    const r = await fetch(`${inst.backendUrl}/api/v1/cloud/status`, {
      signal: AbortSignal.timeout(1500),
    });
    const body = (await r.json()) as {
      data?: { logged_in?: boolean; hub_ws_connected?: boolean };
    };
    if (!body.data?.logged_in) {
      throw new Error(
        `${inst.name} not cloud-logged-in — call POST ${inst.backendUrl}/api/v1/cloud/login (env-mode auto-login) first`,
      );
    }
    if (!body.data?.hub_ws_connected) {
      throw new Error(`${inst.name} hub WS bridge not connected`);
    }
  }
}

/** Open a fresh BrowserContext + Page tuned for one instance. */
export async function openInstance(browser: Browser, inst: InstanceConfig): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ baseURL: inst.uiUrl });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    // Suppress one-time onboarding modals so home-landing buttons are pointer-clickable.
    localStorage.setItem('llm-setup-modal-seen', 'true');
    localStorage.setItem('flowpad-index-approved', '1');
  });
  return { ctx, page };
}

/** Navigate to home-landing and wait for the "Start conversation" button. */
export async function gotoHome(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start conversation' }).waitFor({ state: 'visible' });
}

/**
 * Drive alice's home-landing "Start conversation" dialog → create a hub-mirrored
 * conversation that includes bob as participant. Returns the new conversation id
 * parsed from the URL after Create succeeds.
 *
 * The flow exercised is exactly the pure-UI path the human would walk:
 *   1. click "Start conversation"
 *   2. type bob's email into the participants input, press Enter to add
 *   3. type the initial message
 *   4. click "Create"
 *   5. wait for navigation to /dock/conversation/<id>
 */
export async function startConversationViaUi(
  alicePage: Page,
  bobEmail: string,
  initialMessage: string,
): Promise<string> {
  await gotoHome(alicePage);
  await alicePage.getByRole('button', { name: 'Start conversation' }).click();

  const dialog = alicePage.getByTestId('new-conversation-dialog');
  await dialog.waitFor({ state: 'visible' });

  const participantInput = dialog.getByTestId('participant-input');
  await participantInput.click();
  await participantInput.fill(bobEmail);
  await participantInput.press('Enter');

  const messageInput = dialog.getByTestId('initial-message-input');
  await messageInput.fill(initialMessage);

  // The dialog's Create button is the second of two visible buttons (Cancel + Create).
  await dialog.getByRole('button', { name: 'Create' }).click();

  // After create, FE navigates to /dock/conversation/<id>. We wait on the URL
  // rather than the bubble so we surface a navigation failure fast.
  await alicePage.waitForURL(/\/dock\/conversation\/[0-9a-f-]+/, { timeout: 8_000 });
  const match = alicePage.url().match(/\/dock\/conversation\/([0-9a-f-]+)/);
  if (!match) throw new Error(`Failed to extract conversation id from ${alicePage.url()}`);
  return match[1];
}

/** Send a reply via the composer on whichever side is driving. */
export async function sendReplyViaUi(page: Page, text: string): Promise<{ sentAt: number }> {
  const textarea = page.locator('textarea[placeholder^="Reply to sender"]');
  await textarea.fill(text);
  const sendBtn = page.locator('button[title="Send"]');
  await expect(sendBtn).toBeEnabled({ timeout: 1_000 });
  const sentAt = Date.now();
  await sendBtn.click();
  return { sentAt };
}

/**
 * Poll the DOM until a bubble whose body text equals `expected` appears.
 * Returns the time of arrival (Date.now()). Fails fast — bubbles that don't
 * land within `timeoutMs` raise instead of stalling the test.
 */
export async function waitForBubbleText(page: Page, expected: string, timeoutMs = 2_000): Promise<number> {
  const bubble = page
    .locator('[data-testid^="message-bubble-"]')
    .filter({ has: page.locator(`.text-sm:not(.font-semibold):text-is("${expected}")`) });
  await bubble.first().waitFor({ state: 'visible', timeout: timeoutMs });
  return Date.now();
}

/**
 * Wait until the sender-side bubble matching `text` shows the given receipt
 * status. Receipts on the sender side: Sent → Delivered → Read.
 */
export async function waitForReceipt(
  page: Page,
  text: string,
  status: 'Sent' | 'Delivered' | 'Read',
  timeoutMs = 2_000,
): Promise<number> {
  const bubble = page
    .locator('[data-testid^="message-bubble-"]')
    .filter({ has: page.locator(`.text-sm:not(.font-semibold):text-is("${text}")`) });
  await bubble
    .locator(`span[title="${status}"]`)
    .first()
    .waitFor({ state: 'visible', timeout: timeoutMs });
  return Date.now();
}

/** Navigate a page to /dock/conversation/<id> and wait until the composer is mounted. */
export async function gotoConversation(page: Page, convId: string) {
  await page.goto(`/dock/conversation/${convId}`);
  await page.locator('textarea[placeholder^="Reply to sender"]').waitFor({ state: 'visible' });
}
