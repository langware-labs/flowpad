/**
 * A turn this client did not start is rendered live, and exactly once.
 *
 * `prompt()` streams a turn back to whoever sent it. Every other surface had no
 * source and sat on a stale list until history reloaded at turn end — the "chat
 * pane looks dead after switching to Standard mid-turn" report. `observeTurn()`
 * is that missing source: a read-only stream of the in-flight turn's transcript,
 * open only while a surface is actually watching.
 *
 * Shaped as the foreign-turn case: `submit()` starts a turn WITHOUT streaming it
 * back here (enqueue / PTY stdin), so this client is a pure observer — exactly
 * what a pane is after a mid-turn mode switch.
 *
 * Backend = FLOW_INSTANCE. Spawns one real worker.
 */
import { ComputeNode, WorkerModelTier, dataContext, isBusy } from '@sdk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

const BOOT_MS = 60_000;

describe('observe-turn — a foreign turn renders live, once', () => {
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
    'streams the in-flight turn and leaves no duplicate rows behind',
    async () => {
      const cn = dataContext.computeNode as ComputeNode;
      expect(cn, 'compute node from apiTestSetup').toBeTruthy();

      ap = await cn.createProcess(
        { workerType: 'claude_code', model: WorkerModelTier.SM, permissionMode: 'bypassPermissions' },
        {
          pty_mode: false,
          visible: false,
          watchProcess: true,
          launchPrompt: 'You are a diagnostic helper. Acknowledge each correlation ID you are given.',
        },
      );
      unwatch = ap.watch ? await ap.watch() : null;
      await vi.waitFor(() => expect(ap.session_id).toBeTruthy(), { timeout: BOOT_MS, interval: 500 });

      const token = `OBS${ap.id.replace(/-/g, '').slice(0, 6).toUpperCase()}END`;
      // Start the turn WITHOUT a local stream — this client is now an observer.
      await ap.submit(`Correlation ID ${token}. Reply with two short sentences, then acknowledge ${token}.`);
      await vi.waitFor(() => expect(isBusy(ap)).toBe(true), { timeout: BOOT_MS, interval: 250 });
      expect(ap.isPrompting, 'submit() must not make this client a sender').toBe(false);

      const before = ap.flowDataStream.items.length;
      await ap.observeTurn(); // resolves when the turn ends
      const observed = ap.flowDataStream.items.length - before;
      expect(observed, 'the observation delivered the turn').toBeGreaterThan(0);

      // Reloading the transcript must converge on the same rows, not double them:
      // `reconcileHistoryOverlap` matches what the observation already delivered.
      const liveChat = ap.flowDataStream.items.filter((i: any) => i.elementType === 'chat').length;
      await ap.loadHistory({ force: true });
      const afterChat = ap.flowDataStream.items.filter((i: any) => i.elementType === 'chat').length;
      expect(afterChat, `chat rows changed across a reload (live=${liveChat}, after=${afterChat})`).toBe(liveChat);
    },
    240_000,
  );

  it(
    'is a no-op when no turn is running',
    async () => {
      await vi.waitFor(() => expect(isBusy(ap)).toBe(false), { timeout: BOOT_MS, interval: 250 });
      // Settle against the transcript first: these two cases share a process, so
      // snapshotting straight after the previous turn can race its last row in
      // and make an empty observation look like it delivered something.
      await ap.loadHistory({ force: true });
      const before = ap.flowDataStream.items.length;
      await ap.observeTurn(); // returns immediately, delivers nothing
      expect(ap.flowDataStream.items.length).toBe(before);
    },
    60_000,
  );
});
