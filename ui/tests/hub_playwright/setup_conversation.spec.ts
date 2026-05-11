/**
 * Two-browser conversation setup via the standard hub invitation pattern.
 *
 * Flow (all driven through pure UI interactions):
 *   1. alice opens her UI, clicks "Start conversation", types bob's email,
 *      types an initial message, clicks "Create".
 *      Backend wires it: local Conversation/FlowMessage, ``conv.share()`` on
 *      the hub, ``conversation/<id>/join`` for alice, ``members`` POST to
 *      invite bob.
 *   2. bob opens his UI, clicks the Refresh button on the conversations
 *      strip (``conversation-sync`` pulls his pending invitations from
 *      the hub).
 *   3. bob clicks "Accept" on the pending-invitations row. Backend wires it:
 *      hub ``/members/accept`` (grants ``member`` role on the Conversation),
 *      then ``conversation/<id>/join`` so bob enters ``participants``.
 *   4. Both UIs navigate to the new conversation.
 *   5. alice types a calibration message → bob's UI shows it within the
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
  gotoConversation,
  openInstance,
  sendReplyViaUi,
  startConversationViaUi,
  waitForBubbleText,
} from './helpers';

const BOB_EMAIL = process.env.BOB_CLOUD_EMAIL || 'bob@local.test';

test('setup: alice creates → bob accepts via UI → realtime round-trip < 500 ms', async () => {
  await assertPreconditions();

  const browser: Browser = await chromium.launch();
  try {
    const alice = await openInstance(browser, ALICE);
    const bob = await openInstance(browser, BOB);

    // Open bob's home-landing FIRST so his invitations strip is mounted by
    // the time alice fires the invite — keeps the test honest about realtime
    // perception.
    await bob.page.goto('/');
    await bob.page.getByRole('button', { name: 'Start conversation' }).waitFor({ state: 'visible' });

    // 1. Alice drives the Start-conversation dialog.
    const initial = `setup-${Date.now()}`;
    const t0 = Date.now();
    const convId = await startConversationViaUi(alice.page, BOB_EMAIL, initial);
    const tCreated = Date.now();
    console.log(`[setup] alice created conv ${convId.slice(0, 8)} via UI  (${tCreated - t0} ms)`);

    // 2. Bob clicks Refresh so ``conversation-sync`` pulls pending invitations.
    //    The invitation pull happens before the inbox fetch in the handler,
    //    and ``_materialize_remote_invitation`` saves with ``notify=True`` so
    //    the strip's reactive query updates as soon as the row hits the local
    //    DB — well within 2s of the click.
    await bob.page.getByTestId('refresh-conversations-button').click();
    await bob.page.getByTestId('pending-invitation-row').first()
      .waitFor({ state: 'visible', timeout: 2_000 });

    // 3. Accept every pending invitation visible (the freshly-created one
    //    may share the strip with stale invites from prior runs; accepting
    //    them all is harmless and unambiguous).
    const tInviteSeen = Date.now();
    let rows = await bob.page.getByTestId('pending-invitation-row').all();
    console.log(`[setup] bob sees ${rows.length} pending invitation(s)  (+${tInviteSeen - tCreated} ms)`);
    expect(rows.length).toBeGreaterThan(0);
    for (let i = 0; i < rows.length; i++) {
      // Re-query each iteration — the list re-renders after each accept and
      // detaches previous locators.
      const fresh = await bob.page.getByTestId('pending-invitation-row').all();
      if (fresh.length === 0) break;
      await fresh[0].getByTestId('accept-invitation-button').click();
      // Wait until that row's identity (its accept button label flipping to
      // "Accepting…" then disappearing) settles.
      await bob.page.waitForTimeout(150);
    }
    const tAccepted = Date.now();
    console.log(`[setup] bob accepted all pending invitations  (+${tAccepted - tInviteSeen} ms)`);

    // 4. Both navigate to the conversation.
    await gotoConversation(bob.page, convId);
    await gotoConversation(alice.page, convId);

    // 5. Round-trip: alice sends a calibration message; bob's UI must see it
    //    within the SLO. Alice already has the initial message in her view;
    //    we use a fresh marker so the wait is unambiguous.
    const calibrate = `ping-${Date.now()}`;
    const { sentAt } = await sendReplyViaUi(alice.page, calibrate);
    const tRx = await waitForBubbleText(bob.page, calibrate, 2_000);
    const rtt = tRx - sentAt;
    console.log(`[setup] realtime round-trip alice → bob: ${rtt} ms`);

    expect(convId).toMatch(/^[0-9a-f-]{36}$/);
    expect(rtt).toBeLessThan(500); // realtime SLO
  } finally {
    await browser.close();
  }
});
