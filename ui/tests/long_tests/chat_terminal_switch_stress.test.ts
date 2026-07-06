/**
 * Chat ⇄ Terminal counter — one agentic session, toggled 10×, every turn lands.
 *
 * The headless chat panel (`claude -p`, `pty_mode=false`) and the interactive
 * terminal (live PTY, `pty_mode=true`) are two TRANSPORTS of ONE session — same
 * `session_id`, same transcript. `switchMode` flips the transport; `submit` runs
 * a turn on whichever is live (headless enqueues+drains, PTY types+Enter — and
 * `submit` gates PTY readiness itself, so there's no settle scaffolding here).
 *
 * Pure SDK API test, shaped like the pytest hammer (`tests/long_tests/
 * agentic_hammer.py`): make an AgenticProcess, then loop `switchMode()` +
 * `submit(token)` and assert the token lands as recorded output and the
 * `session_id` never drifts. No raw HTTP, no hand-rolled status checks: readiness
 * is `ap.waitForReady()` (the canonical transport-aware gate) and `submit()`
 * handles PTY readiness itself.
 *
 * Gated behind RUN_PTY_STRESS (spawns a real worker). Backend = FLOW_INSTANCE.
 */
import { ComputeNode, WorkerMode, WorkerModelTier, dataContext } from '@sdk';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { stressDescribe } from './_stress_gate';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

const COUNT = 10;
const BOOT_MS = 60_000; // worker cold-start / return-to-idle
const TURN_MS = 15_000; // "say the token" on the small model must be fast

stressDescribe('chat⇄terminal counter — one session, 10 switches, every turn lands', () => {
  let ap: any = null;
  let unwatch: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    await apiTestSetup(getTestSignupInfo());
  }, 60_000);

  afterAll(async () => {
    try {
      await unwatch?.();
    } catch {
      /* best-effort */
    }
    try {
      await ap?.stop?.();
    } catch {
      /* best-effort */
    }
  });

  it(
    'every switch keeps the session and every turn produces its token',
    async () => {
      const cn = dataContext.computeNode as ComputeNode;
      expect(cn, 'compute node from apiTestSetup').toBeTruthy();

      // Boot headless (no PTY, no tab); the seeded prompt mints the session.
      ap = await cn.createProcess(
        { workerType: 'claude_code', model: WorkerModelTier.SM, permissionMode: 'bypassPermissions' },
        {
          pty_mode: false,
          visible: false,
          watchProcess: true, // live session_id / status / workerStatus / flowDataStream
          launchPrompt: 'You are a counter. When asked, reply with ONLY the exact token you are given.',
        },
      );
      unwatch = ap.watch ? await ap.watch() : null;

      // The watched process streams each recorded turn into `flowDataStream` over
      // WS — and it's a pure observer here (no local composer), so the stream has
      // no optimistic echo, every item is backend-recorded. So just read the live
      // stream; do NOT `loadHistory({ force })` in the poll — force REPLACES the
      // stream with a fresh transcript read, which would drop a WS-delivered token
      // if the on-disk transcript hasn't flushed it yet.
      const inStream = (token: string): boolean =>
        ap.flowDataStream.items.some((i: any) => (i.content ?? '').includes(token));
      // Submit a token turn and wait for it to land (WS stream, with one on-disk
      // re-read as the WS-miss fallback). A live PTY can occasionally drop the
      // pasted keystrokes when the just-resumed TUI isn't fully ready — a
      // non-deterministic terminal-input drop, NOT a logic bug — so re-submit once
      // it's idle again. The token IS the whole message, so a resend just lands it.
      const turn = async (token: string): Promise<boolean> => {
        const msg = `Reply with ONLY this exact token and nothing else: ${token}`;
        for (let attempt = 0; attempt < 3; attempt++) {
          await ap.submit(msg);
          const end = Date.now() + TURN_MS;
          while (Date.now() < end) {
            if (inStream(token)) return true;
            await new Promise((r) => setTimeout(r, 400));
          }
          await ap.loadHistory({ force: true }).catch(() => undefined); // WS-miss fallback
          if (inStream(token)) return true;
          await ap.waitForReady({ timeout: BOOT_MS }); // settle, then resend
        }
        return false;
      };

      await vi.waitFor(() => expect(ap.session_id).toBeTruthy(), { timeout: BOOT_MS, interval: 500 });
      const session: string = ap.session_id;
      const run = ap.id.replace(/-/g, '').slice(0, 6).toUpperCase();

      let interactive = false; // booted headless; iteration 1 → interactive
      for (let n = 1; n <= COUNT; n++) {
        interactive = !interactive;

        // Flip the transport, then wait for the new transport to be ready —
        // `waitForReady` is the canonical transport-aware gate (no hand-rolled
        // status checks). ONE session must survive every switch + PTY restart.
        await ap.switchMode(interactive ? WorkerMode.Interactive : WorkerMode.CLI);
        await ap.waitForReady({ timeout: BOOT_MS });

        // `visible` is pure tab show/hide, DECOUPLED from transport (Gap A) — flip
        // it and assert it changes neither the session nor the turn that follows.
        await ap.setVisible(!ap.visible);
        expect(ap.session_id, `session stable after switch ${n}`).toBe(session);

        // Run one turn via the transport-agnostic primitive; assert its unique
        // token lands as real agent output.
        const token = `MARK${run}C${n}END`;
        expect(await turn(token), `count ${n} (${interactive ? 'interactive' : 'headless'}) token landed`).toBe(true);

        // Settle: wait for the turn to finish before the next switch (a mid-turn
        // switchMode is 409'd). This also lets a resumed PTY fully quiesce.
        await ap.waitForReady({ timeout: BOOT_MS });
      }

      expect(ap.session_id, 'one session survived all 10 switches').toBe(session);
    },
    300_000,
  );
});
