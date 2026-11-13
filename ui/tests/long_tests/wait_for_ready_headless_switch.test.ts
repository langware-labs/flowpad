/**
 * `waitForReady()` is documented as "the same gate the UI toggle uses, so it can't 409". For a HEADLESS process
 * it used to return at once (`!this.pty_mode || ...`) while the server's `switch-mode` still 409'd
 * ("a turn is in flight", `is_turn_busy`) until the turn ended, so `waitForReady()` → `switchMode()` failed
 * right after boot, while the seeded launch turn was still running.
 *
 * Real call path, no mocks: a real headless claude process, `waitForReady()`, then `switchMode(Interactive)`.
 * Guards the fix (517e107a2): a headless `waitForReady()` waits until no turn holds the slot, so the switch
 * right after it is accepted. Without it the switch fails with "Request failed with status code 409".
 *
 * Gated behind RUN_PTY_STRESS (spawns a real worker). Backend = FLOW_INSTANCE.
 */
import { ComputeNode, WorkerMode, WorkerModelTier, dataContext } from '@sdk';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { stressDescribe } from './_stress_gate';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

// flowpad:capsule tag
// version: 1
// data:
//   tags:
//     breadcrumb.test.headless_wait_ready.rules: FAILING? read this tag's rules before
//       touching waitForReady's headless gate
// flowpad:endcapsule tag
stressDescribe('waitForReady on a headless process, then switchMode', () => {
  let ap: any = null;

  beforeAll(async () => {
    await apiTestSetup(getTestSignupInfo());
  }, 60_000);

  afterAll(async () => {
    try {
      await ap?.stop?.();
    } catch {
      /* best-effort */
    }
  });

  it('a switch right after waitForReady() is not refused as "a turn is in flight"', async () => {
    const cn = dataContext.computeNode as ComputeNode;
    ap = await cn.createProcess(
      { workerType: 'claude_code', model: WorkerModelTier.SM, permissionMode: 'bypassPermissions' },
      {
        pty_mode: false,
        visible: false,
        watchProcess: true,
        launchPrompt: 'Count slowly from 1 to 30, one number per line, then say done.',
      },
    );
    await vi.waitFor(() => expect(ap.session_id).toBeTruthy(), { timeout: 60_000, interval: 300 });

    await ap.waitForReady({ timeout: 60_000 });
    await expect(ap.switchMode(WorkerMode.Interactive)).resolves.toBeUndefined();
  }, 180_000);
});
