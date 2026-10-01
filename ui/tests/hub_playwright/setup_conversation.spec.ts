/**
 * Two-browser conversation setup via the hub invitation (granted at invite time).
 *
 * Flow (all driven through pure UI interactions):
 *   1. alice opens her UI, clicks "Start conversation", types bob's email,
 *      types an initial message, clicks "Create".
 *      Backend wires it: local Conversation/FlowMessage, ``conv.share()`` on
 *      the hub, ``conversation/<id>/join`` for alice, ``members`` POST to
 *      invite bob.
 *   2. bob already has his home open. The hub grants an invitation at
 *      INVITE time (``invitation_auto_accept_on_invite``, the assignment model
 *      — hub ``membership/services.py::_maybe_auto_accept``, since 2026-07-30):
 *      bob is a ``member`` the moment alice invites him, and the hub pushes
 *      the conversation to his bridge. No pending invitation, no Accept click —
 *      the conversation row itself lands on bob's strip in realtime.
 *   3. Both UIs navigate to the new conversation.
 *   4. alice types a calibration message → bob's UI shows it within the
 *      realtime SLO (< 500 ms).
 *
 * Prereqs (checked up-front; test skips with a clear reason otherwise):
 *   - alice backend (9008), bob backend (9007), local hub (8093) all up
 *   - both backends cloud-logged-in, both hub WS bridges connected
 *
 * Run on its own:
 *   npx playwright test --config ui/tests/hub_playwright/playwright.config.ts \
 *     setup_conversation.spec.ts
 */
import { test, expect, chromium, type Browser } from '@playwright/test';

import {
  ALICE,
  BOB,
  assertPreconditions,
  gotoHome,
  openConversationFromStrip,
  openInstance,
  sendReplyViaUi,
  startConversationViaUi,
  waitForBubbleText,
  waitForConversationReady,
} from './helpers';

const BOB_EMAIL = process.env.BOB_CLOUD_EMAIL || 'bob@local.test';

test('setup: alice creates → bob is a member at once → realtime round-trip < 500 ms', async () => {
  await assertPreconditions();

  const browser: Browser = await chromium.launch();
  try {
    const alice = await openInstance(browser, ALICE);
    const bob = await openInstance(browser, BOB);

    // Bob's home-landing is mounted before alice fires the invite — keeps the
    // test honest about realtime perception. Both cold loads run side by side:
    // each pulls the whole dev bundle (~2000 modules), and serially they alone
    // ate ~7 s of the 10 s budget at host load ~10.
    await Promise.all([gotoHome(bob.page), gotoHome(alice.page)]);

    // 1. Alice drives the Start-conversation dialog.
    const initial = `setup-${Date.now()}`;
    const t0 = Date.now();
    const convId = await startConversationViaUi(alice.page, BOB_EMAIL, initial, { onHome: true });
    const tCreated = Date.now();
    console.log(`[setup] alice created conv ${convId.slice(0, 8)} via UI  (${tCreated - t0} ms)`);

    // 2. Bob's strip shows the conversation itself, pushed in realtime — no
    //    Refresh, no Accept: the hub already made him a member at invite time.
    await bob.page
      .locator(`[data-testid="conversation-row"][data-conversation-id="${convId}"]`)
      .waitFor({ state: 'visible', timeout: 2_000 });
    console.log(`[setup] bob sees the conversation on his strip  (+${Date.now() - tCreated} ms)`);

    // 3. Both are in the conversation: bob opens it from his strip, alice is
    //    already on it (Create navigated her there).
    await openConversationFromStrip(bob.page, convId);
    await waitForConversationReady(alice.page);

    // 4. Round-trip: alice sends a calibration message; bob's UI must see it
    //    within the SLO. Alice already has the initial message in her view;
    //    we use a fresh marker so the wait is unambiguous.
    const calibrate = `ping-${Date.now()}`;
    const { sentAt } = await sendReplyViaUi(alice.page, calibrate);
    let tRx: number;
    try {
      tRx = await waitForBubbleText(bob.page, calibrate, 2_000);
    } catch (e) {
      // RCA dump: did the message land in bob's local DB? did the bubble even render?
      const bubbleCount = await bob.page.locator('[data-testid^="message-bubble-"]').count();
      const bubbleTexts = await bob.page.locator('[data-testid^="message-bubble-"] .text-sm:not(.font-semibold)').allInnerTexts();
      const bobFm = await fetch(`${BOB.backendUrl}/api/v1/graph/conversation/${convId}/messages`).then((r) => r.json()).catch(() => null);
      console.log('[rca] bob bubbles:', bubbleCount, JSON.stringify(bubbleTexts));
      console.log('[rca] bob backend messages:', JSON.stringify(bobFm));
      throw e;
    }
    const rtt = tRx - sentAt;
    console.log(`[setup] realtime round-trip alice → bob: ${rtt} ms`);

    expect(convId).toMatch(/^[0-9a-f-]{36}$/);
    expect(rtt).toBeLessThan(500); // realtime SLO
  } finally {
    await browser.close();
  }
});
