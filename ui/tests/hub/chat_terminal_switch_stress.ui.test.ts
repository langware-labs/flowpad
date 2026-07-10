/**
 * Chat ⇄ Terminal mode-switch stress — IN THE BROWSER (one logical session).
 *
 * UI sibling of ../long_tests/chat_terminal_switch_stress.test.ts. That test
 * drives the ENTITY through the SDK; this one drives the REAL UI toggle button
 * in a headless Chromium and proves the switch survives 10 rapid round-trips
 * without the pane desyncing, the session drifting, or the status indicator
 * going stale. It exists to catch the stale-broadcast clobber the SDK
 * desired-value latch fixes (agentic-process.ts `_pendingPtyMode`/
 * `_pendingVisible`): an in-flight entity broadcast carrying the pre-switch
 * `pty_mode` must NOT flip the pane back after the user toggles.
 *
 * The chat⇄terminal toggle (`handleToggleView`) does TWO things at once: it
 * flips the UI SKIN (chat pane over the PTY ⇄ raw xterm) and the TRANSPORT
 * (`switchMode` → `pty_mode` true⇄false). One live session underneath both.
 *
 * Two clients, one backend (instance `dev-1`):
 *   • the browser PAGE drives the toggle / types tokens (production path:
 *     click → handleToggleView → switchMode);
 *   • an SDK realm (`getInstance('dev-1')`) creates the watched process and is
 *     the AUTHORITATIVE observer — `loadHistory({force})` re-reads the on-disk
 *     transcript so a token hit means the worker actually took it (not the
 *     optimistic echo), and `workerStatus` is the backend's idle signal.
 *
 * Each iteration toggles the surface, asserts the destination pane mounted +
 * the session_id is unchanged + the status indicator reads idle. Liveness is
 * proven on ALL 10 iterations by driving a unique per-count token turn and
 * asserting it lands as real AGENT output — proof the one session stays usable
 * across the PTY restarts. The driver is transport-specific, because the two
 * transports accept a turn differently (RCA #20):
 *   • PTY iterations → the `prompt` action (`proc.prompt` → `_run_pty_prompt`),
 *     which injects the turn into the (re)started TUI with a submission-confirm
 *     nudge and streams the transcript back as flow_data. Typing raw keystrokes
 *     into the freshly cold-restarted xterm (`proc.submit()` on PTY) drops them
 *     before the TUI accepts input AND emits no flow_data — no turn to observe.
 *   • headless iterations → `proc.submit()` (enqueue+drain streams agent output).
 * The token-landing check matches only non-user entries, since both the prompt
 * action's transcript replay and `proc.prompt()`'s optimistic echo carry the
 * USER turn (which contains the token verbatim) — see `tokenInStream`. A slow
 * turn trips the tight per-step budget — a regression, never something to wait out.
 *
 * Lifecycle is external (like every hub test): `scripts/instance_ctl.sh launch
 * dev-1` + the hub up, else the suite SKIPS. Run:
 *   cd ui && FLOWPAD_HUB_URL=http://localhost:8093 \
 *     npx vitest run --project hub chat_terminal_switch_stress.ui
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import {
  launchBrowser,
  openInstancePage,
  dismissWelcomeModal,
  realConsoleErrors,
  resetConsoleErrors,
  type InstancePage,
} from './_browser';
import { getInstance, instanceAvailable, type ResolvedInstance } from './_instances';
import { hubAvailable } from './_hub';
import { trackTypeId } from '../_cleanup';

const INSTANCE = 'dev-1';
const COUNT_TARGET = 10;
// Per-step budgets are the real guards (NOT the it() envelope). A "say the
// token" turn on the small model must be fast; a slow turn is a regression.
const BOOT_BUDGET_MS = 60_000; // PTY spawn/teardown + worker reaches awaiting-input
const TURN_BUDGET_MS = 10_000; // counter budget: token must land in 10s
const SWITCH_BUDGET_MS = 30_000; // toggle disabled (switching/mid-turn) → re-enabled

// Chat status-indicator labels that mean "the agent is waiting for you" (idle).
// Mirrors status-indicator.tsx; the non-idle labels are Thinking/Using tool/etc.
const IDLE_STATUS = new Set(['Idle', 'Complete', 'Interrupted']);

describe('chat⇄terminal switch stress in the browser — one session, 10 iterations', () => {
  let browser: Browser | null = null;
  let inst: ResolvedInstance | null = null;
  let page: InstancePage | null = null;
  let proc: any = null;
  let unwatch: (() => Promise<void>) | null = null;
  let available = false;

  beforeAll(async () => {
    if (!(await hubAvailable()).ok || !(await instanceAvailable(INSTANCE))) {
      // eslint-disable-next-line no-console
      console.warn(`[skip] hub or instance '${INSTANCE}' not up — launch via scripts/instance_ctl.sh`);
      return;
    }
    available = true;
    browser = await launchBrowser();

    // SDK realm (authoritative observer + process factory) bound to dev-1.
    inst = await getInstance(INSTANCE);
    const cn = await inst.sdk.ComputeNode.getById('@local');
    expect(cn, 'no @local compute node on dev-1').toBeTruthy();

    // Run the worker in an OUT-OF-REPO tmpdir: a worker writing under the checkout
    // trips the instance backend's file-watch and destabilises it mid-run.
    const { mkdtempSync } = await import('node:fs');
    const os = await import('node:os');
    const nodePath = await import('node:path');
    const workdir = mkdtempSync(nodePath.join(os.tmpdir(), 'flowpad-switch-'));

    // Production START path: visible auto-start opens a live PTY and seeds the
    // launch prompt that mints the session_id. The process boots in TERMINAL
    // (pty_mode=true); the dev instance is Advanced so the dock shows the xterm,
    // and iteration 1's toggle is the first chat switch. `visible:false` would
    // never drain the launch prompt (no auto-start) → no session; that mismatch
    // was the original boot flake.
    proc = await cn!.createProcess(
      {
        workerType: 'claude_code',
        model: inst.sdk.WorkerModelTier.SM, // → haiku, resolved backend-side
        permissionMode: 'bypassPermissions',
        workdir,
      },
      {
        pty_mode: true,
        visible: true,
        watchProcess: true,
        launchPrompt: 'You are a counter. When asked, reply with ONLY the exact token you are given.',
      },
    );
    expect(proc?.id, 'process created').toBeTruthy();
    trackTypeId('agentic_process', proc.id); // hub _setup.ts afterEach purges it
    unwatch = proc.watch ? await proc.watch() : null;
    await waitFor(() => !!proc.session_id, BOOT_BUDGET_MS, 'session_id on first boot');

    // Open the dock through the PRODUCTION nav path. A raw `goto` to the dock URL
    // redirects to the active-project scope (the projectless test process isn't
    // shown there) — `openShellProcess` resolves the process + opens its tab
    // correctly, which is also what a real click does.
    page = await openInstancePage(browser!, INSTANCE);
    await page.page.evaluate(
      (id) => (window as any).navigation.openShellProcess(id),
      proc.id as string,
    );
    await dismissWelcomeModal(page.page);
    await page.page.getByTestId('terminal-chat-toggle').waitFor({ state: 'visible', timeout: 20_000 });
    await waitToggleEnabled(); // worker idle after the seeded turn
    resetConsoleErrors(page); // drop boot/navigation noise before the measured loop
  }, 120_000);

  afterAll(async () => {
    try {
      await unwatch?.();
    } catch {
      /* best-effort */
    }
    try {
      await proc?.stop?.();
    } catch {
      /* best-effort */
    }
    // The process row + asset_ref are purged by the hub _setup.ts afterEach
    // (trackTypeId above); no hand-rolled DELETE needed here.
    await browser?.close().catch(() => undefined);
  });

  /** Poll a sync predicate against the live (watched) SDK proc. */
  async function waitFor(pred: () => boolean, budgetMs: number, label: string): Promise<void> {
    const end = Date.now() + budgetMs;
    for (;;) {
      if (pred()) return;
      if (Date.now() > end) {
        throw new Error(`${label}: status=${proc?.status} worker=${proc?.workerStatus} pty=${proc?.pty_mode}`);
      }
      await page!.page.waitForTimeout(300);
    }
  }

  /** Read the toggle's three state attrs in ONE round-trip. */
  async function readToggle(): Promise<{ enabled: boolean; switching: boolean; chatActive: boolean }> {
    return page!.page.getByTestId('terminal-chat-toggle').evaluate((el) => ({
      enabled: el.getAttribute('data-toggle-enabled') === 'true',
      switching: el.getAttribute('data-switching') === 'true',
      chatActive: el.getAttribute('data-chat-active') === 'true',
    }));
  }

  /** The toggle is enabled iff the agent is awaiting input AND not mid-switch —
   *  one wait covers both the idle gate and the switching spinner. (The button's
   *  own `disabled` is exactly `switching || !toggleEnabled`, so these two cover
   *  it — no separate isDisabled() probe.) */
  async function waitToggleEnabled(): Promise<void> {
    const end = Date.now() + SWITCH_BUDGET_MS;
    for (;;) {
      const t = await readToggle().catch(() => null);
      if (t && t.enabled && !t.switching) return;
      if (Date.now() > end) {
        throw new Error(
          `toggle never re-enabled (stuck mid-turn/switching) — toggle=${JSON.stringify(t)} ` +
            `backend=${proc?.status}/${proc?.workerStatus} pty=${proc?.pty_mode}`,
        );
      }
      await page!.page.waitForTimeout(250);
    }
  }

  /** The browser's live `process.pty_mode` (the TRANSPORT) from the active panel —
   *  true = interactive PTY, false = headless. This is the authoritative switch
   *  signal, held stable by the SDK desired-value latch, so we key the test on it
   *  rather than the chat SKIN (`data-chat-active`), whose `chatOverride`
   *  preference has an intermittent re-render race under rapid toggling. */
  async function currentPty(): Promise<boolean | null> {
    const v = await page!.page
      .locator('[data-testid="terminal-panel"][data-active="true"]')
      .getAttribute('data-pty-mode')
      .catch(() => null);
    return v === 'true' ? true : v === 'false' ? false : null;
  }

  /** Drive the TRANSPORT to `targetPty` via the real toggle button. Keyed on
   *  `pty_mode` (reliable) not the skin. `handleToggleView` early-returns if the
   *  worker isn't awaiting at the click instant (a silent no-op), and sets
   *  `switching=true` asynchronously — so after each click we wait for the switch
   *  to settle then check whether the transport reached the target; if not (a
   *  no-op, or a wrong-direction skin race) we re-click. Since every click flips
   *  the transport and we verify the RESULT, it converges. Bounded. */
  async function switchTransportTo(targetPty: boolean): Promise<void> {
    for (let attempt = 0; attempt < 6; attempt++) {
      await waitToggleEnabled();
      if ((await currentPty()) === targetPty) return; // already there
      // Fire onClick directly: a Playwright pointer-click can land on the tooltip
      // <span> wrapper and miss; el.click() always invokes handleToggleView.
      await page!.page
        .getByTestId('terminal-chat-toggle')
        .evaluate((el) => (el as HTMLButtonElement).click());
      const end = Date.now() + SWITCH_BUDGET_MS;
      let settled = false;
      while (Date.now() < end) {
        const t = await readToggle().catch(() => null);
        if (t && t.enabled && !t.switching) {
          settled = true;
          break;
        }
        await page!.page.waitForTimeout(150);
      }
      if (settled && (await currentPty()) === targetPty) return; // switched
      // settled-but-not-switched (no-op) or still switching → re-click
    }
    throw new Error(
      `transport never reached pty=${targetPty} — pty=${await currentPty()} ` +
        `override=${await page!.page.evaluate(() => (window as any).getChatUi?.()).catch(() => 'err')} ` +
        `backend=${proc?.status}/${proc?.workerStatus} sdkPty=${proc?.pty_mode}`,
    );
  }

  /** Console errors attributable to the SWITCH (the thing under test), with one
   *  KNOWN, PRE-EXISTING exclusion called out honestly: PTY spawn/teardown does
   *  blocking work on the single-process backend's event loop, so an in-flight
   *  project-list `fetch()` from the navigator can reject ("Failed to list
   *  projects: Failed to fetch"). That is a real backend loop-stall (same family
   *  as the createprocess/indexer loop-pinning issues), NOT introduced by the
   *  switch and NOT what this test validates — fixing it means moving PTY
   *  spawn off the loop, a separate change. Excluded here (not in the shared
   *  filter, which stays strict) so this suite asserts switch correctness; a real
   *  switch bug still surfaces as a React/render/uncaught error. */
  function switchErrors(): string[] {
    return realConsoleErrors(page!.consoleErrors).filter(
      (e) => !e.includes('Failed to fetch') && !e.includes('Failed to list projects'),
    );
  }

  /** Has `token` landed as REAL AGENT output? The SDK realm proc is WATCHED, so
   *  the backend-recorded turn streams into `flowDataStream` over WS — plus, on
   *  PTY iterations, the `prompt` action's own streamed transcript flows in via
   *  `proc.prompt()` (see the liveness step). We match only NON-user entries
   *  (`role !== 'user'`): both the `prompt` action's transcript poll AND
   *  `proc.prompt()`'s optimistic user echo replay the USER turn — which contains
   *  the token verbatim (it's the instruction) — so an unfiltered match would
   *  false-positive on the prompt itself, never proving the agent replied. Agent
   *  output is tagged `role: 'assistant'` (or carries no role on the headless
   *  print-stream); the user turn is tagged `role: 'user'` on both sides.
   *  We do NOT `loadHistory({force})` on every poll — a full transcript re-read
   *  every 400ms hammered the single-process backend and starved the PTY switches
   *  (the cause of the mid-run "toggle never re-enabled" wedge). Tokens are unique
   *  per count, so a stale item can't false-positive. */
  function tokenInStream(token: string): boolean {
    return proc.flowDataStream.items.some(
      (entry: any) =>
        (entry.attributes?.role ?? '') !== 'user' && (entry.content ?? '').includes(token),
    );
  }
  /** One authoritative on-disk re-read — the WS-miss fallback, used at most once
   *  per turn (not in the hot poll loop). */
  async function tokenLandedForce(token: string): Promise<boolean> {
    await proc.loadHistory({ force: true }).catch(() => undefined);
    return tokenInStream(token);
  }

  it(
    'toggles transport 10× via the real button — one session, status idle, every turn lands',
    async () => {
      expect(available, `instance '${INSTANCE}' + hub must be up`).toBe(true);
      const p = page!.page;
      const run = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`.toUpperCase();
      const tokenFor = (n: number) => `MARK${run}C${n}END`;

      const sessionId: string = proc.session_id;
      expect(sessionId, 'session_id assigned on first boot').toBeTruthy();

      const chatPane = p.getByTestId('simple-chat-pane');
      const activePanel = p.locator('[data-testid="terminal-panel"][data-active="true"]');
      const xterm = activePanel.locator('.xterm');

      const perCount: Array<{
        count: number;
        transport: 'pty' | 'headless';
        skinMatched: boolean; // did the chat SKIN follow the transport? (logged, not asserted)
        tokenSeen: boolean;
        sessionStable: boolean;
        statusIdle: boolean;
      }> = [];

      // Alternate the TRANSPORT each iteration, starting from the opposite of where
      // we boot. `pty_mode` is the authoritative switch axis (held by the latch);
      // the chat SKIN is a separate rendering with a known reactivity race, so we
      // key control flow on the transport, not the skin.
      const bootPty = await currentPty();
      let targetPty = !(bootPty ?? true);

      for (let count = 1; count <= COUNT_TARGET; count++, targetPty = !targetPty) {
        // 1) TOGGLE the transport via the real UI button.
        await switchTransportTo(targetPty);
        const onPty = targetPty; // true = interactive PTY, false = headless chat

        // 2) ONE logical session across every toggle + PTY restart. Live SDK state
        //    is authoritative; the in-DOM worker-session attr must agree (the latch
        //    keeps it from being clobbered by a stale broadcast).
        expect(proc.session_id, `session stable after toggle ${count}`).toBe(sessionId);
        const domSession = await activePanel.getAttribute('data-worker-session-id').catch(() => null);
        if (domSession) expect(domSession, 'DOM worker-session matches backend').toBe(sessionId);

        // 3) STATUS INDICATOR is idle. The logical wire `status` (ready ⇔ the
        //    worker is awaiting the user) is the authoritative cross-transport
        //    signal; when the chat SKIN happens to be showing, its label must agree.
        const statusIdle = inst!.sdk.isReadyForInput(proc);
        if ((await readToggle().catch(() => null))?.chatActive) {
          const statusText = (await p.getByTestId('simple-chat-status').textContent().catch(() => '')) ?? '';
          expect(IDLE_STATUS.has(statusText.trim()), `chat status idle at count ${count} (was "${statusText}")`).toBe(true);
        }

        // 4) SKIN follows transport: headless ⇒ chat pane; PTY ⇒ a mounted xterm.
        //    Checking only that chat is hidden is insufficient: a mode round trip
        //    can otherwise leave the whole content area blank while pty_mode=true.
        const expectedSurface = onPty ? xterm : chatPane;
        const skinMatched = await expectedSurface
          .waitFor({ state: 'visible', timeout: 4_000 })
          .then(() => true)
          .catch(() => false);

        // 5) LIVENESS — the one session is usable after the switch. Drive a token
        //    turn on the CURRENT transport and see it land as REAL agent output in
        //    the shared transcript. The transport dictates the driver:
        //      • PTY  → the `prompt` action (`proc.prompt` → `_run_pty_prompt`): it
        //        INJECTS the turn into the (re)started TUI with a submission-confirm
        //        nudge AND streams the transcript back as flow_data. `proc.submit()`
        //        here would type raw keystrokes into the freshly cold-restarted PTY
        //        (they drop before it accepts input) and its PTY path emits no
        //        flow_data at all — so no turn, nothing to observe (RCA #20).
        //      • headless → `proc.submit()` (enqueue+drain streams the print-mode
        //        agent output) — already the right channel there.
        //    Not awaited before the poll: the streaming turn ingests concurrently,
        //    so the tight TURN_BUDGET still governs "the token must land fast" — a
        //    slow turn is a regression, never waited out.
        const token = tokenFor(count);
        const promptText = `Reply with ONLY this exact token and nothing else: ${token}`;
        const turnPromise = (onPty ? proc.prompt(promptText) : proc.submit(promptText)).catch(
          () => undefined,
        );
        let tokenSeen = false;
        const turnEnd = Date.now() + TURN_BUDGET_MS;
        while (Date.now() < turnEnd) {
          if (tokenInStream(token)) {
            tokenSeen = true;
            break;
          }
          await p.waitForTimeout(400);
        }
        if (!tokenSeen) tokenSeen = await tokenLandedForce(token); // one WS-miss fallback
        await turnPromise; // let the streaming turn settle before the next toggle
        await waitToggleEnabled(); // turn complete (worker back to idle) before next toggle

        // 6) Console must stay clean across the switch + turn.
        expect(switchErrors(), `switch-relevant console errors at count ${count}`).toEqual([]);
        resetConsoleErrors(page!);

        perCount.push({
          count,
          transport: onPty ? 'pty' : 'headless',
          skinMatched,
          tokenSeen,
          sessionStable: proc.session_id === sessionId,
          statusIdle,
        });
        // eslint-disable-next-line no-console
        console.log(
          `• count ${String(count).padStart(2)}  transport=${(onPty ? 'pty' : 'headless').padEnd(8)}` +
            `  skin=${skinMatched ? 'ok ' : 'LAG'}  token=${tokenSeen ? 'OK ' : 'MISS'}` +
            `  session=${proc.session_id === sessionId ? 'same' : 'CHANGED'}  status=${proc.workerStatus}`,
        );
      }

      // ── Assert. ───────────────────────────────────────────────────────────
      const drift = perCount.filter((r) => !r.sessionStable);
      // Both transports genuinely exercised across the 10 toggles.
      expect(perCount.filter((r) => r.transport === 'pty').length).toBeGreaterThan(0);
      expect(perCount.filter((r) => r.transport === 'headless').length).toBeGreaterThan(0);
      // The whole point: one logical session survived every toggle + PTY restart.
      expect(drift, 'session_id changed on some iteration').toEqual([]);
      // The status indicator agreed the agent was idle before each toggle.
      expect(perCount.every((r) => r.statusIdle), 'worker not idle before some toggle').toBe(true);
      // Every settled transport must expose its usable surface; pty=true with no
      // xterm is a blank-terminal regression, not an acceptable skin lag.
      expect(
        perCount.every((r) => r.skinMatched),
        'surface did not follow some transport switch',
      ).toBe(true);
      // Every turn produced real agent output — the one session stayed live through
      // every switch, via the transport-appropriate driver (PTY: prompt action,
      // headless: submit) and asserted as non-user (agent) output.
      expect(
        perCount.every((r) => r.tokenSeen === true),
        'some turn produced no agent output across the switches',
      ).toBe(true);
    },
    300_000,
  );
});
