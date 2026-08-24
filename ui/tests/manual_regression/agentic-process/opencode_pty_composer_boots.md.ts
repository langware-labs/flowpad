/**
 * OpenCode opener spawns a PTY whose TUI reaches its composer.
 * Source: opencode_pty_composer_boots.md
 *
 * The only scenario that drives an opencode session end to end. Everything else
 * in the suite pins claude/codex — via an explicit `worker_type` on
 * `createProcess` or by clicking `opener-menu-row-claude` — so the argv the
 * driver builds for the BARE TUI is otherwise never exercised in a browser.
 *
 * That is the gap this closes. `opencode run` accepts `--dir`/`--variant`; the
 * bare TUI (`opencode [project]`) accepts neither and takes the directory as a
 * positional, so emitting either flag made yargs dump usage and exit 1 — the PTY
 * worker died before painting a composer. Asserting on the entity alone sails
 * past that; only the PTY's own output catches it.
 */
import { expect, test } from '@playwright/test';
import { apiBase } from '../_shared/api';
import { withViewMode } from '../_shared/view-mode';

const API = apiBase();

/** The capability kind whose `state` decides whether opencode is usable here. */
const OPENCODE_HARNESS_KIND = 'harness.opencode.cli';

/**
 * Vendor-dependent gate. This scenario needs the real `opencode` binary, which
 * not every machine has, so it is a CONDITIONAL skip on the backend's own
 * capability row rather than a hard failure. The harness rows are `system: true`
 * and hidden from the default listing, hence `include_system=true`; they are
 * looked up by `kind` so no deterministic id is baked into the test.
 */
async function skipUnlessOpenCodeAvailable() {
  const res = await fetch(`${API}/api/v1/graph/capability?include_system=true`);
  const rows = (await res.json())?.data ?? [];
  const harness = rows.find((r: { kind?: string }) => r.kind === OPENCODE_HARNESS_KIND);
  const state = harness?.state ?? 'missing';
  test.skip(
    state !== 'available',
    `${OPENCODE_HARNESS_KIND} is "${state}", not "available" — the opencode CLI is not installed/usable ` +
      'on this host, so no PTY can be spawned for it. Not a product failure.',
  );
}

test('opencode opener spawns a PTY whose TUI paints its composer', async ({ page }) => {
  await skipUnlessOpenCodeAvailable();

  await page.addInitScript(() => {
    localStorage.setItem('llm-setup-modal-seen', 'true');
  });

  await page.goto(withViewMode('/dock/shell/new_terminal', 'advanced'));
  await page.locator('[data-testid="terminal-panels"]').waitFor({ state: 'visible' });
  await page
    .locator('[data-testid="terminal-panel"][data-active="true"] .xterm-rows')
    .first()
    .waitFor({ state: 'attached' });

  // The opener must offer opencode at all — an id missing from the opener's
  // value space would silently drop the vendor from the "+" menu.
  await page.locator('[data-testid="opener-plus-button"]').click();
  const row = page.locator('[data-testid="opener-menu-row-opencode"]');
  await expect(row, 'opener menu must offer an opencode row').toBeVisible();
  await row.click();

  // A real process, not a bare shell and not the `new` placeholder. Same regex
  // and same 30s budget `_ap_helpers.startClaude` already uses for this exact
  // opener→dock transition — the suite's established value for it, not a wider
  // one chosen to ride past a stall.
  await page.waitForURL(/\/dock\/shell\/agentic_process-(?!new)/, { timeout: 30_000 });

  // The composer marker — the same string the driver gates typed delivery on
  // (`pty_composer_ready_pattern`). Measured on opencode 1.18.18: ~2.1s in a raw
  // PTY, ~11.5s end-to-end through the app. The budget below is sized off that
  // measurement, not tuned upward to make a slow path pass.
  await expect(
    page.locator('[data-testid="terminal-panel"][data-active="true"] .xterm-rows').first(),
    'opencode TUI must reach its composer — a rejected argv exits before painting it',
  ).toContainText(/Ask anything/, { timeout: 30_000 });
});
