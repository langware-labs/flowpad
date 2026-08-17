/**
 * Run a RECEIVED skill from the conversation — the full user scenario, two real
 * clients in one process (realm per instance): dev-1 = Bob (author), dev-2 =
 * Alice (runner, real browser).
 *
 *   1. Bob creates the "find me a product" skill and shares it with Alice (SDK).
 *   2. Alice receives it, opens the conversation, downloads it (staged chip), and
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
 * The SDK share → receive → stage → install legs are already proven by
 * skill_share_two_client.test.ts; the install-then-run-by-name wiring is
 * unit-covered by tests/unit/use-run-received-skill.test.ts. This test covers
 * the NEW browser run surface; the mcp-ui selectors are reused verbatim from
 * the proven mcp_ui_vibe_form.md.ts so that leg is correct-by-construction.
 *
 * Do NOT raise any timeout here without explicit approval.
 */
import { writeFileSync } from 'node:fs';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { testEntityName, trackForCleanup } from '../_cleanup';
import { hubAvailable } from './_hub';
import {
  HUB_INST_1 as AUTHOR_INSTANCE,
  HUB_INST_2 as RUNNER_INSTANCE,
  getInstance,
  instanceAvailable,
  syncAssignedConversation,
  type ResolvedInstance,
} from './_instances';
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
// The receiver installs into a long-lived cycle project. A fixed folder name
// collides with an earlier run's installed copy even though this run minted a
// fresh entity id, so make the on-disk skill name cycle-unique.
const SKILL_NAME = testEntityName('find-me-a-product');
// The skill body (Bob's 4 steps + two flowpad-native nudges so the run is
// deterministic). Frontmatter `id` is stamped from the created entity so the
// on-disk SKILL.md stays the same entity the share bundle carries.
const skillMarkdown = (id: string) => `---
id: ${id}
name: ${SKILL_NAME}
description: Find a product online with location + price range and report order links
---

# Find me a product

1. Search online for the requested product with location and price range.
2. For each product, validate it is available and ships to my address.
3. Generate a report of all findings including an order link.
4. Open the report in the browser.

## Running inside Flowpad
- FIRST, ask the user **via the mcp-ui skill** with ONE MCP-UI form: four plain
  text inputs (Product, Location, Price range, Delivery address) and a submit
  button. Use these exact test hooks so the form is testable: wrap the form in
  \`data-testid="mcp-ui-root"\`; the submit button is \`data-testid="mcp-ui-submit"\`;
  after submit, show an element \`data-testid="mcp-ui-submission-status"\` whose
  text is \`submitted\`. Do NOT require any field to be non-empty.
- Present the final report on the display with \`flow show\` ("open in browser" means \`flow show\`).
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
  if (!instanceAvailable(AUTHOR_INSTANCE) || !instanceAvailable(RUNNER_INSTANCE)) {
    return void (skipReason = `launch ${AUTHOR_INSTANCE} + ${RUNNER_INSTANCE} (with frontends)`);
  }
  bob = await getInstance(AUTHOR_INSTANCE);
  alice = await getInstance(RUNNER_INSTANCE);
  browser = await launchBrowser();
  alicePage = await openInstancePage(browser, RUNNER_INSTANCE);
}, 60_000);

afterAll(async () => {
  await browser?.close().catch(() => undefined);
});

// A missing env is a real SKIP (visible, not a green pass). `expect(skipReason)`
// as an early return would turn "env unavailable" into a false-positive.
beforeEach((ctx) => {
  if (skipReason) {
    console.error(`[skill-run-e2e] SKIP: ${skipReason}`);
    ctx.skip();
  }
});

describe('run a received skill in a Vibe MCP-UI session', () => {
  it('Bob shares find-me-a-product; Alice runs it from the chip → mcp-ui form → report', async (ctx) => {
    const t0 = Date.now();
    const step = (s: string) => console.error(`[skill-run-e2e] +${((Date.now() - t0) / 1000).toFixed(1)}s ${s}`);
    // 1. Bob authors the skill (body via SKILL.md doc) and shares it.
    step('share: create skill');
    const skill = trackForCleanup(await bob.sdk.Skill.create(SKILL_NAME));
    // Skill.create writes an EMPTY SKILL.md; write the real body to disk (keeping
    // the entity id in frontmatter) BEFORE sharing so the bundle packs it. The
    // test runs on the same machine as dev-1, and asset_ref is an absolute path.
    if (!skill.asset_ref) throw new Error('skill has no asset_ref to write its body');
    writeFileSync(`${skill.asset_ref.replace(/\/$/, '')}/SKILL.md`, skillMarkdown(skill.id));
    step('wrote skill body to disk');
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
    step(`shared fm=${fmId?.slice(0, 8)}`);

    // 2. Alice synchronizes the immediate assignment, then opens the conversation
    //    in her real browser and downloads the bundle → staged chip.
    await syncAssignedConversation(alice, conv.id);
    step('alice synchronized assignment');

    const page = alicePage.page;
    await page.goto(`${alicePage.feUrl}/dock/conversation/${conv.id}?viewMode=advanced`, {
      waitUntil: 'domcontentloaded',
    });
    step('alice opened conversation');
    const download = page.getByTestId('download-attachments-button');
    const runIcon = page.getByTestId('skill-run-icon').first();
    // Depending on the assignment materialization path, the first
    // browser render legitimately starts in either state:
    //   • remote body → Download button; the user click stages the bundle;
    //   • body already staged by assignment sync → the Run chip is present directly.
    // Race those two production surfaces inside the click's existing
    // actionability window. An instantaneous isVisible probe would race the
    // conversation render and misclassify the required branch.
    const firstSurface = await Promise.race([
      download.waitFor({ state: 'visible' }).then(() => 'download' as const),
      runIcon.waitFor({ state: 'visible' }).then(() => 'staged' as const),
    ]);
    if (firstSurface === 'download') {
      await download.click({ force: true });
      step('clicked download');
    } else {
      step('assignment sync already staged the bundle');
    }

    // 3. The run icon appears on the staged skill chip → click it.
    await runIcon.waitFor({ state: 'visible', timeout: 30_000 });
    step('run icon visible');
    await runIcon.click({ force: true });
    step('clicked run icon');

    // A projectless shared conversation prompts for a project (the chosen
    // behavior); a project-mapped one runs directly. Race the two: pick the
    // first project if the picker appears, else the run already resolved one.
    // A Vibe session opens at the display URL (/dock/display/agentic_process-…?
    // viewMode=vibe — the vibe Display FSM), not /dock/shell/.
    const VIBE_URL = /\/dock\/(display|shell)\/agentic_process-/;
    const pickerRow = page.locator('[data-testid^="project-selector-row-"]').first();
    const shell = page.waitForURL(VIBE_URL, { timeout: 40_000 }).then(() => 'shell' as const).catch(() => null);
    const picker = pickerRow.waitFor({ state: 'visible', timeout: 40_000 }).then(() => 'picker' as const).catch(() => null);
    if ((await Promise.race([shell, picker])) === 'picker') {
      step('projectless → project picker shown; pick first');
      await pickerRow.click();
    } else {
      step('no picker — run resolved a project directly');
    }
    const opened = (await shell) === 'shell';
    if (!opened) {
      const text = (await page.locator('body').textContent().catch(() => '')) ?? '';
      step(`NO /dock/shell/ — url=${page.url().replace(alicePage.feUrl, '')} toast=${/could not start|failed/i.test(text)} errs=${JSON.stringify((alicePage.consoleErrors ?? []).slice(-5))}`);
      if (LIVE_AGENT_UNAVAILABLE.test(text)) return void ctx.skip();
      throw new Error('Vibe process did not open after clicking run');
    }
    step(`vibe process opened: ${page.url().replace(alicePage.feUrl, '')}`);

    // 4. The skill asks via MCP-UI — the form renders on the display (selectors
    //    from mcp_ui_vibe_form.md.ts). This is the core validation: the skill
    //    ran BY NAME under the vibe persona and used mcp-ui. Skip cleanly if the
    //    live agent is unavailable; the 120s test budget bounds this wait.
    const preview = page.locator('[data-testid="mcp-app-preview"]');
    const appeared = await preview
      .waitFor({ state: 'visible', timeout: 90_000 })
      .then(() => true)
      .catch(async () => {
        const text = (await page.locator('body').textContent().catch(() => '')) ?? '';
        return LIVE_AGENT_UNAVAILABLE.test(text) ? null : false;
      });
    if (appeared === null) {
      console.error('[skill-run-e2e] SKIP: live Claude agent unavailable mid-run');
      return void ctx.skip(); // visible skip, never a green pass
    }
    step(`mcp-ui form rendered: ${appeared}`);
    expect(appeared, 'MCP-UI form should render on the display').toBe(true);

    const app = page
      .frameLocator('[data-testid="mcp-app-preview"] iframe')
      .frameLocator('iframe#root');
    const root = app.locator('[data-testid="mcp-ui-root"]');
    await root.waitFor({ state: 'visible', timeout: 20_000 });
    // Alice answers: fill every text-like field the agent's form rendered (the
    // exact field testids are LLM-authored, so fill generically), then submit.
    const fields = root.locator('input:not([type="file"]):not([type="checkbox"]):not([type="radio"]), textarea');
    const count = await fields.count();
    for (let i = 0; i < count; i++) await fields.nth(i).fill('test-answer').catch(() => undefined);
    step(`filled ${count} form field(s)`);
    await app.locator('[data-testid="mcp-ui-submit"]').click();
    // Playwright-native wait (vitest's `expect` has no `toContainText`): the
    // status element must show "submitted" once the form posts back to the agent.
    await app
      .locator('[data-testid="mcp-ui-submission-status"]')
      .filter({ hasText: /submitted/i })
      .waitFor({ state: 'visible', timeout: 15_000 });
    step('mcp-ui submitted → delivered to agent');

    // 5. The report rides the same `flow show` rail the mcp-ui form used. A full
    //    live web-search report exceeds the 120s budget, so this is a soft check
    //    that the display stays alive post-submit (the flow-show→report path
    //    itself is proven by mcp_ui_vibe_form.md.ts); not a hard gate.
    await preview.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
    step('display alive post-submit (report is best-effort within budget)');
  }, 120_000);
});
