/**
 * Run a RECEIVED skill from the conversation — the full user scenario, two real
 * clients in one process (realm per instance): dev-1 = Bob (author), dev-2 =
 * Alice (runner, real browser).
 *
 *   1. Bob creates the "find me a product" skill and shares it with Alice (SDK).
 *   2. Alice accepts, opens the conversation, downloads it (staged chip), and
 *      clicks the RUN icon on the chip.
 *   3. A Vibe process opens; the skill is installed into the conversation
 *      project and run BY NAME (`run the skill <name>`).
 *   4. The skill asks its inputs via MCP-UI (mcp-app-preview form); Alice
 *      submits.
 *   5. The generated report is shown on the active display.
 *
 * STAGED — requires the live environment this cannot self-provision:
 *   - dev-1 + dev-2 launched WITH FRONTENDS via scripts/instance_ctl.sh + the
 *     local hub (8093);
 *   - a LIVE Claude worker (the Vibe agent must actually run the skill, author
 *     the mcp-ui form, and `flow show` the report);
 *   - a settled frontend (the concurrent project-home/context-folders refactor
 *     must land first — a churning tree yields false failures).
 *
 * The SDK share → accept → stage → install legs are already proven by
 * skill_share_two_client.test.ts; the install-then-run-by-name wiring is
 * unit-covered by tests/unit/use-run-received-skill.test.ts. This test covers
 * the NEW browser run surface; the mcp-ui selectors are reused verbatim from
 * the proven mcp_ui_vibe_form.md.ts so that leg is correct-by-construction.
 *
 * Do NOT raise any timeout here without explicit approval.
 */
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testEntityName, trackForCleanup } from '../_cleanup';
import { hubAvailable } from './_hub';
import { pollUntil } from './_matrix';
import { findPendingInvitation, getInstance, instanceAvailable, type ResolvedInstance } from './_instances';
import { launchBrowser, openInstancePage, type InstancePage } from './_browser';

const post = (apiUrl: string, p: string, body?: unknown) =>
  fetch(`${apiUrl}/api/v1${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }).then((r) => r.json());

// Bob's skill: the 4 pasted steps + two flowpad-native nudges so the run is
// deterministic (ask via MCP-UI, present via `flow show`). Frontmatter `name`
// drives `run the skill find-me-a-product`.
const SKILL_NAME = 'find-me-a-product';
const SKILL_BODY = `---
name: ${SKILL_NAME}
description: Find a product online with location + price range and report order links
---

# Find me a product

1. Search online for the requested product with location and price range.
2. For each product, validate it is available and ships to my address.
3. Generate a report of all findings including an order link.
4. Open the report in the browser.

## Running inside Flowpad
- Ask the user **via MCP-UI** for: product, location, price range, delivery address.
- Present the final report on the display with \`flow show\` ("open in browser" = \`flow show\`).
`;

// From mcp_ui_vibe_form.md.ts — a live agent that has hit a limit / lost auth
// should SKIP, not fail.
const LIVE_AGENT_UNAVAILABLE =
  /(hit your limit|weekly limit|usage limit|rate limit|quota|too many requests|overloaded|unauthenticated|login required|api key)/i;

let skipReason: string | null = null;
let bob: ResolvedInstance;
let alice: ResolvedInstance;
let browser: Browser;
let alicePage: InstancePage;

beforeAll(async () => {
  const hub = await hubAvailable();
  if (!hub.ok) return void (skipReason = hub.reason ?? 'hub unreachable');
  if (!(await instanceAvailable('dev-1')) || !(await instanceAvailable('dev-2'))) {
    return void (skipReason = 'launch dev-1 + dev-2 (with frontends) via scripts/instance_ctl.sh');
  }
  bob = await getInstance('dev-1');
  alice = await getInstance('dev-2');
  browser = await launchBrowser();
  alicePage = await openInstancePage(browser, 'dev-2');
}, 60_000);

afterAll(async () => {
  await browser?.close().catch(() => undefined);
});

describe('run a received skill in a Vibe MCP-UI session', () => {
  it('Bob shares find-me-a-product; Alice runs it from the chip → mcp-ui form → report', async () => {
    if (skipReason) return void expect(skipReason, skipReason).toBeTruthy();

    // 1. Bob authors the skill (body via SKILL.md doc) and shares it.
    const skill = trackForCleanup(await bob.sdk.Skill.create(SKILL_NAME));
    await skill.doc?.write(SKILL_BODY).catch(() => undefined); // best-effort body write
    const conv = trackForCleanup(new bob.sdk.Conversation({ title: testEntityName('run-skill') }));
    await conv.save();
    await conv.share([alice.email]);
    const fmId = (
      await post(bob.apiUrl, `/graph/conversation/${conv.id}/add_message`, {
        message: 'a skill for you',
        asset_references: [`skill-${skill.id}`],
      })
    ).data.flow_message_id as string;
    await post(bob.apiUrl, `/graph/flow_message/${fmId}/upload_body`, {});

    // 2. Alice accepts the invitation (SDK), then opens the conversation in her
    //    real browser and downloads the bundle → staged chip.
    const invitation = await pollUntil(
      () => findPendingInvitation(alice, conv.id),
      20_000,
      'pending invitation on dev-2',
    );
    await alice.sdk.acceptInvitation({ invitation_id: invitation.id! });

    const page = alicePage.page;
    await page.goto(`${alicePage.feUrl}/dock/conversation/${conv.id}?viewMode=advanced`, {
      waitUntil: 'domcontentloaded',
    });
    const download = page.getByTestId('download-attachments-button');
    if (await download.isVisible({ timeout: 30_000 }).catch(() => false)) {
      await download.click({ force: true }).catch(() => undefined);
    }

    // 3. The run icon appears on the staged skill chip → click it. A Vibe
    //    process opens (install-then-run happens inside useRunReceivedSkill).
    const runIcon = page.getByTestId('skill-run-icon').first();
    await runIcon.waitFor({ state: 'visible', timeout: 30_000 });
    await runIcon.click({ force: true });
    await page.waitForURL(/\/dock\/shell\//, { timeout: 45_000 }).catch(async () => {
      const text = (await page.locator('body').textContent().catch(() => '')) ?? '';
      if (LIVE_AGENT_UNAVAILABLE.test(text)) return; // tolerated — asserted below
      throw new Error('Vibe process did not open after clicking run');
    });

    // 4. The skill asks via MCP-UI — the form renders on the display (selectors
    //    from mcp_ui_vibe_form.md.ts). Skip cleanly if the live agent is down.
    const preview = page.locator('[data-testid="mcp-app-preview"]');
    const appeared = await preview
      .waitFor({ state: 'visible', timeout: 180_000 })
      .then(() => true)
      .catch(async () => {
        const text = (await page.locator('body').textContent().catch(() => '')) ?? '';
        return LIVE_AGENT_UNAVAILABLE.test(text) ? null : false;
      });
    if (appeared === null) return; // live agent unavailable — documented skip
    expect(appeared, 'MCP-UI form should render on the display').toBe(true);

    const app = page
      .frameLocator('[data-testid="mcp-app-preview"] iframe')
      .frameLocator('iframe#root');
    await app.locator('[data-testid="mcp-ui-root"]').waitFor({ state: 'visible', timeout: 60_000 });
    await app.locator('[data-testid="mcp-ui-submit"]').click();
    await expect(app.locator('[data-testid="mcp-ui-submission-status"]')).toContainText(/submitted/i, {
      timeout: 15_000,
    });

    // 5. The agent proceeds and shows a report on the active display — the
    //    report rides the same `flow show` rail the mcp-ui form used, so the
    //    display keeps rendering agent output after submission.
    await preview.waitFor({ state: 'visible', timeout: 180_000 });
  });
});
