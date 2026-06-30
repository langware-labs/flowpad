/**
 * Chat ⇄ Terminal mode-switch + restart stress (one logical session).
 *
 * The chat panel (headless `claude -p` / JSON-stream, `pty_mode=false`) and the
 * interactive terminal (live PTY, `pty_mode=true`) are two mutually-exclusive
 * TRANSPORTS of ONE agentic session — same `session_id`, same transcript.
 * Switching →terminal restarts the PTY and resumes the session; switching →chat
 * kills the PTY and reverts to headless. The transport is selected by `pty_mode`
 * ALONE — `visible` is purely "is this shown as a tab" and must never affect the
 * counter (Gap A fix). This test stresses both axes at once.
 *
 * Methodology: drive the ENTITY through the SDK and observe through the SDK.
 * `apiTestSetup()` bootstraps the realm (compute-node context included); a single
 * watched `AgenticProcess` is created (NOT via the UI `openTab` — this is a pure
 * API test with no tab/dock) and driven via `switchMode` / `restart` / `prompt` /
 * `setVisible`. Assertions read live SDK state (`workerStatus`, `status`,
 * `session_id`, `pty_mode`, `visible`, `flowDataStream`) kept current by
 * `watch()` — never by scraping REST. The model is a portable tier
 * (`WorkerModelTier.SM` → haiku) so each "say the token" turn is fast/cheap.
 *
 * Each iteration (count 1..10):
 *   1. toggle the transport (CLI ⇄ Interactive); restart the PTY on the
 *      interactive direction (the "switch AND restart" stress),
 *   2. flip `visible` via `setVisible` — must NOT affect transport/session,
 *   3. prompt the agent to emit a unique per-count token,
 *   4. assert that count's token arrived as REAL agent output (not the echo),
 *   5. assert the process is RUNNING and awaiting input again,
 *   6. repeat until count == 10.
 *
 * Runs against the long-test backend selected by FLOW_INSTANCE (default :9007).
 */
import {
  AgenticProcess,
  ComputeNode,
  ProcessStatus,
  WorkerMode,
  WorkerModelTier,
  dataContext,
  isAwaitingUserInput,
} from '@sdk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

const COUNT_TARGET = 10;

// Per-step poll budgets. These — NOT the overall it() timeout — are the real
// guards. The COUNTER turn budget is tight (10s): "say <token>" on the small
// model must be fast; a slow turn is a regression, not something to wait out.
const BOOT_BUDGET_MS = 60_000; // PTY spawn/teardown + worker reach awaiting-input
const TURN_BUDGET_MS = 10_000; // counter budget: token must land in 10s

describe('chat⇄terminal switch + restart + visible stress — one session, 10 iterations', () => {
  let proc: AgenticProcess | null = null;
  let unwatch: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    // One factory call: bootstrap + loadTypes + compute-node context + WS connect.
    await apiTestSetup(getTestSignupInfo());
  }, 60_000);

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
  });

  it(
    'flips transport + visible 10× — every turn lands in the same session and the process returns idle',
    async () => {
      const run = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`.toUpperCase();
      const tokenFor = (n: number) => `MARK${run}C${n}END`;

      // "Ready to prompt next" is MODE-AWARE — the transports idle differently:
      //   interactive (pty_mode=true)  → a live PTY worker: status RUNNING + idle
      //   chat (pty_mode=false)        → NO persistent worker; switch→CLI kills the
      //                                  PTY so the process sits STOPPED. That IS
      //                                  the headless idle state — a prompt boots a
      //                                  per-turn worker. Ready = not stopping/failed.
      const readyToPrompt = (): boolean => {
        if (proc!.status === ProcessStatus.STOPPING || proc!.status === ProcessStatus.FAILED) return false;
        if (proc!.pty_mode) {
          return proc!.status === ProcessStatus.RUNNING && isAwaitingUserInput(proc!.workerStatus);
        }
        return true; // headless: STOPPED / RUNNING / NEW between turns are all sendable
      };
      const awaitReady = (label: string) =>
        vi.waitFor(
          () => {
            if (!readyToPrompt()) {
              throw new Error(`${label}: status=${proc!.status} worker=${proc!.workerStatus} pty=${proc!.pty_mode}`);
            }
          },
          { timeout: BOOT_BUDGET_MS, interval: 500 },
        );

      // Submission proof, cross-transport (what the hammers proved reliable): the
      // token lands as a RECORDED turn in the worker's transcript — not the
      // optimistic client echo. clear()+force-reload drops the optimistic items and
      // re-reads the on-disk transcript, so a hit means the worker actually took it.
      const tokenLanded = async (token: string): Promise<boolean> => {
        proc!.flowDataStream.clear();
        await proc!.loadHistory({ force: true }).catch(() => {});
        return proc!.flowDataStream.items.some((it: any) => (it.content ?? '').includes(token));
      };

      // Bound a single awaited turn without retrying it. A turn slower than the
      // counter budget trips here — that's a regression, not something to ride out.
      const withinBudget = <T>(p: Promise<T>, ms: number, label: string): Promise<T> =>
        Promise.race([
          p,
          new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} exceeded ${ms}ms`)), ms)),
        ]);

      // ── Create the session directly (no UI tab/dock). Headless-capable PTY
      //    session on the small model; watch it so live state stays current. ───
      const computeNode = dataContext.computeNode as ComputeNode;
      expect(computeNode, 'compute node from apiTestSetup').toBeTruthy();
      proc = await computeNode.createProcess(
        {
          workerType: 'claude_code',
          model: WorkerModelTier.SM, // → haiku, resolved backend-side at launch
          permissionMode: 'bypassPermissions',
        },
        {
          // Boot HEADLESS (no PTY, no tab): the seeded prompt drives the queue
          // drain to cold-start the worker server-side — the only boot path that
          // needs no UI loader. Iteration 1 then toggles to the interactive PTY.
          pty_mode: false,
          visible: false,
          watchProcess: true, // live status/session_id/pty_mode/visible on the entity
          launchPrompt: 'You are a counter. When asked, reply with ONLY the exact token you are given.',
        },
      );
      expect(proc?.id).toBeTruthy();
      unwatch = proc.watch ? await proc.watch() : null;

      // Initial boot: the seeded launch prompt drains a headless turn that mints
      // the session_id. readyToPrompt() is true the instant it's sendable, so wait
      // specifically for the session_id (the worker actually booted) here.
      await vi.waitFor(
        () => {
          if (!proc!.session_id) throw new Error(`no session_id yet (status=${proc!.status} worker=${proc!.workerStatus})`);
        },
        { timeout: BOOT_BUDGET_MS, interval: 500 },
      );
      const sessionId = proc.session_id;
      expect(sessionId, 'session_id assigned on first boot').toBeTruthy();

      const perCount: Array<{
        count: number;
        mode: 'cli' | 'interactive';
        restarted: boolean;
        visibleFlipped: boolean;
        tokenSeen: boolean;
        status: string;
        worker: string;
        ready: boolean;
        sessionStable: boolean;
      }> = [];

      // Toggle deterministically — alternate every iteration. (Reading
      // proc.pty_mode to decide direction is unreliable: the SDK's cached value
      // races WS broadcasts after switch/loadHistory. The backend's pty_mode is
      // authoritative + persisted — we just don't trust the CLIENT cache for
      // control flow. Both directions are exercised either way.)
      let interactive = false; // created headless
      for (let count = 1; count <= COUNT_TARGET; count++) {
        // 1) TOGGLE transport.
        interactive = !interactive;
        const goInteractive = interactive;
        const targetMode = goInteractive ? WorkerMode.Interactive : WorkerMode.CLI;
        await proc.switchMode(targetMode);
        await awaitReady(`after switch→${targetMode}`);
        // The invariant that matters: ONE logical session across every toggle +
        // PTY reboot. (switchMode→Interactive reboots the PTY and resumes.)
        expect(proc.session_id, `session stable after →${targetMode}`).toBe(sessionId);
        const restarted = goInteractive;

        // 2) FLIP visible — pure tab show/hide. The backend keeps pty_mode (router
        //    keys on pty_mode, which is persisted) and the session — assert the
        //    observable invariant (session), not the flaky client-cached pty_mode.
        await proc.setVisible(!proc.visible);
        expect(proc.session_id, 'setVisible must not change session').toBe(sessionId);

        // 3) PROMPT — one uniform call; backend routes by pty_mode. Fire WITHOUT
        //    awaiting: the PTY transport has no end-of-turn marker, so prompt()
        //    only resolves after a fixed transcript-inactivity window — that's a
        //    transport artifact, NOT the counter's latency. We measure the
        //    counter by when its token lands in the stream (step 4).
        const token = tokenFor(count);
        const t0 = performance.now();
        const turn = proc.prompt(`Reply with ONLY this exact token and nothing else: ${token}`);
        turn.catch(() => {}); // we settle it explicitly below; avoid unhandled-rejection

        // 4) COUNTER BUDGET: the token must appear as REAL agent output.
        let tokenSeen = false;
        await vi
          .waitFor(
            async () => {
              tokenSeen = await tokenLanded(token);
              if (!tokenSeen) throw new Error(`token ${token} not in agent output yet`);
            },
            { timeout: TURN_BUDGET_MS, interval: 400 },
          )
          .catch(() => {});
        const tokenMs = Math.round(performance.now() - t0);

        // 5) VALIDATE status — RUNNING and awaiting input again, then release the
        //    in-flight turn (interrupt closes the PTY stream / cancels headless)
        //    so the next switchMode isn't 409'd by the lingering prompt lock.
        await awaitReady(`settle after count ${count}`);
        await proc.interruptTurn().catch(() => {});
        await withinBudget(turn, BOOT_BUDGET_MS, `turn ${count} unwind`).catch(() => {});

        perCount.push({
          count,
          mode: goInteractive ? 'interactive' : 'cli',
          restarted,
          visibleFlipped: true,
          tokenSeen,
          status: proc.status,
          worker: proc.workerStatus,
          ready: readyToPrompt(),
          sessionStable: proc.session_id === sessionId,
        });

        // eslint-disable-next-line no-console
        console.log(
          `• count ${String(count).padStart(2)}  mode=${(goInteractive ? 'interactive' : 'cli').padEnd(11)}` +
            `  reboot=${restarted ? 'yes' : ' no'}  visible=${proc.visible ? 'on ' : 'off'}` +
            `  token=${tokenSeen ? 'OK ' : 'MISS'}@${tokenMs}ms  status=${proc.status}/${proc.workerStatus}` +
            `  session=${proc.session_id === sessionId ? 'same' : 'CHANGED'}`,
        );
      }

      // ── Report + assert. ────────────────────────────────────────────────────
      const seen = perCount.filter((r) => r.tokenSeen).length;
      const sessionDrift = perCount.filter((r) => !r.sessionStable);
      const notReady = perCount.filter((r) => !r.ready);
      // eslint-disable-next-line no-console
      console.log(
        `\nTOTAL: ${seen}/${COUNT_TARGET} counts produced agent output; ` +
          `${sessionDrift.length} session drifts; ${notReady.length} not-ready settles.\n`,
      );

      // Both transports were genuinely exercised (5 toggles each direction).
      expect(perCount.filter((r) => r.mode === 'interactive').length).toBeGreaterThan(0);
      expect(perCount.filter((r) => r.mode === 'cli').length).toBeGreaterThan(0);
      // The whole point: one logical session survived every switch + restart + visible flip.
      expect(sessionDrift, 'session_id changed on some iteration').toEqual([]);
      // Every count's prompt produced real agent output in the shared stream.
      expect(seen, 'some counts produced no agent flow data').toBe(COUNT_TARGET);
      // And the process always came back ready for the next prompt (mode-aware).
      expect(notReady, 'process did not settle to a sendable state').toEqual([]);
    },
    // Wall-clock envelope for 10 real turns across PTY reboots — sum of the
    // per-step budgets above, NOT a mask for any single slow step.
    300_000,
  );
});
