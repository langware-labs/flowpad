/**
 * End-to-end PtyEvent fire pipeline.
 *
 *   1. Start an AgenticProcess and wait for the PTY to attach.
 *   2. Register a ``PtyEvent`` watcher with a known pattern + label.
 *   3. Send the input ``"where is the plan some.md?"`` into Claude's TUI.
 *      The text echoes back as PTY output and our line stream sees it.
 *   4. Validate that a fire was recorded in ``shell.getPtyEventFires()``
 *      with the exact label, pattern source, line content, and match[0].
 *
 * Real backend at localhost:9008. Real Claude PTY spawned. We DO NOT need
 * Claude to respond — the test only depends on the typed input echoing
 * through the PTY line stream, which happens in <2s.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { AgenticProcess, type Shell } from '@sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

const TIMEOUT = 60_000;
const POLL_MS = 100;

/** Matches the substring "plan some.md" — case-insensitive. */
const TEST_PATTERN = /plan some\.md/i;
const TEST_LABEL = 'test-plan-some-md';
const TEST_INPUT = 'where is the plan some.md?';

async function waitFor<T>(
  fn: () => T | undefined | null,
  budgetMs: number,
  label = '',
): Promise<T> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const v = fn();
    if (v) return v as T;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  throw new Error(`waitFor timed out: ${label}`);
}

async function getShellWhenReady(proc: AgenticProcess): Promise<Shell> {
  // The Shell entity is created server-side during ``proc.start()``.
  const shell = await proc.shell();
  if (!shell) throw new Error('proc.shell() returned null after start()');
  return shell;
}

describe('PtyEvent fire pipeline — end-to-end', () => {
  beforeEach(async (ctx: any) => {
    await apiTestSetup(getTestSignupInfo(), ctx.task.name);
  });

  let proc: AgenticProcess | null = null;
  afterEach(async () => {
    if (proc) {
      try { await proc.exit(); } catch { /* ignore */ }
      try { await proc.delete(); } catch { /* ignore */ }
      proc = null;
    }
  });

  it(
    'typed input echoed through PTY fires a registered PtyEvent with the right values',
    async () => {
      // 1. Spawn an AgenticProcess with a tmp workdir.
      const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-event-fire-'));
      proc = await new AgenticProcess({ workdir, visible: true }).save([]);
      await proc.start({ visible: true });

      // 2. Wait for the PTY to be live before sending input. ``sendInput``
      // silently no-ops if the PTY isn't attached yet. Same readiness flag
      // ``plan_detection.test.ts`` uses.
      await waitFor(
        () => (proc!.ptyConnection?.isLive ? true : null),
        30_000,
        'PTY live',
      );

      const shell = await getShellWhenReady(proc);
      const pty = proc.ptyConnection!;

      // Resolve replay before registering — we only want LIVE fires
      // for the assertions, not pre-attach replay matches.
      await waitFor(() => (pty.replayDone ? true : null), 15_000, 'replay done');

      // Snapshot count of fires that already exist (e.g. plan-detection
      // could have fired during banner rendering — irrelevant to us).
      const baselineFireCount = shell.getPtyEventFires().length;

      // 3. Register our test watcher AFTER replay so duringReplay=false
      // is part of the contract we're verifying.
      const noopOnMatch = (): void => { /* the ring buffer records the fire */ };
      const unsub = shell.addTrigger({
        pattern: TEST_PATTERN,
        label: TEST_LABEL,
        onMatch: noopOnMatch,
      });

      try {
        // 4. Send the input. Claude's TUI bracketed-paste-wraps a single
        //    chunk, so a trailing \r in the same write is absorbed as
        //    paste content rather than treated as Enter. Split the
        //    keystrokes the same way plan_detection.test.ts does.
        await pty.sendInput(TEST_INPUT);
        await new Promise((r) => setTimeout(r, 1_500));
        await pty.sendInput('\r');

        // 5. Wait for at least one fire under our test label.
        const fire = await waitFor(
          () => {
            const all = shell.getPtyEventFires();
            return all.find(
              (f) =>
                f.label === TEST_LABEL &&
                // ``shell.getPtyEventFires`` returns oldest-first; consider
                // only fires recorded AFTER our baseline snapshot in case
                // the ring already had unrelated fires.
                all.indexOf(f) >= baselineFireCount,
            );
          },
          15_000,
          `fire under label="${TEST_LABEL}"`,
        );

        // 6. Validate the fire's values.
        expect(fire.label, 'label').toBe(TEST_LABEL);
        expect(fire.patternSource, 'patternSource').toBe(TEST_PATTERN.toString());
        expect(fire.duringReplay, 'should be a live fire (post-replay)').toBe(false);
        expect(fire.line.toLowerCase(), 'line should contain the input substring').toContain(
          'plan some.md',
        );
        expect(fire.match.length, 'match should have at least one element').toBeGreaterThan(0);
        expect(fire.match[0].toLowerCase(), 'match[0] should be the matched substring').toBe(
          'plan some.md',
        );
        expect(fire.id, 'id should be a non-empty string').toMatch(/.+/);
        expect(typeof fire.ts, 'ts should be a number').toBe('number');
        expect(fire.ts, 'ts should be recent (within last 60s)').toBeGreaterThan(Date.now() - 60_000);

        // 7. Smoke: registered watcher count includes ours.
        expect(shell.getRegisteredPtyEventCount(), 'watcher count').toBeGreaterThan(0);

        // 8. Counter goes up. Total fire count must have grown vs the
        // baseline snapshot taken before the watcher was registered.
        const allFires = shell.getPtyEventFires();
        expect(allFires.length, 'total fires increased after input').toBeGreaterThan(
          baselineFireCount,
        );
        expect(allFires.some((f) => f.id === fire.id), 'fire visible in snapshot').toBe(true);
      } finally {
        unsub();
      }
    },
    TIMEOUT,
  );
});
