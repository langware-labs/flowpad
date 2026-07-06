/**
 * RCA capture: createProcess(claude) latency degrades with concurrent live PTYs.
 *
 * Proven this session: createProcess's own work is fast (~0.4s) on a fresh
 * instance and even on a 220MB prod DB — but its wall time scales with the
 * number of concurrent live claude PTY sessions the single backend process is
 * servicing (0 → ~0.4s, ~9 → ~3.9s, ~90 → ~40s). The PTY read/decode loops
 * oversubscribe the event loop / GIL, so a new createProcess's awaits are
 * delayed in proportion to the live-session count.
 *
 * This pins the expected behaviour at the integration layer: with 20 live
 * claude PTYs already up, the 21st createProcess must still return in < 500ms.
 * It FAILS today (the 21st is far slower) and passes once the oversubscription
 * is fixed (PTY I/O off the event-loop/GIL path).
 *
 * Narrowest layer that reproduces: real instance + real claude PTYs. The bug is
 * a runtime concurrency effect — it does not exist at the unit layer.
 *
 * Run: cd ui && npx vitest run --project long create_process_under_live_ptys
 */
import { describe, expect, it } from 'vitest';
import { stressDescribe } from './_stress_gate';
import { launchInstance, killInstance, prepareCleanRealm } from './_backend_lifecycle';

type SdkRealm = typeof import('@sdk');

const LIVE_PTYS = Number(process.env.LIVE_PTYS) || 20;
const BUDGET_MS = 500;

stressDescribe('createProcess(claude) under 20 live PTYs', () => {
  it('21st createProcess returns in < 500ms with 20 live claude PTYs', async () => {
    const name = 'cp-20pty';
    const port = await launchInstance(name);
    if (!port) {
      await killInstance(name);
      throw new Error(`${name} failed to launch / become healthy`);
    }

    const spawned: string[] = [];
    try {
      const { sdk, main } = await prepareCleanRealm(port);
      await main.initSdk();
      expect((window as Record<string, unknown>).appReady, 'initSdk should complete').toBe(true);

      const cn = await sdk.ComputeNode.getById<InstanceType<SdkRealm['ComputeNode']>>('@local');
      if (!cn) throw new Error('No @local compute node after initSdk');

      const spawnOne = async () => {
        const proc = await cn.createProcess(
          { workerType: 'claude_code', permissionMode: 'bypassPermissions' },
          { visible: true, watchProcess: false },
        );
        spawned.push(proc.id);
        return proc;
      };

      // Bring up 20 live claude PTYs.
      for (let i = 0; i < LIVE_PTYS; i++) await spawnOne();

      // The measured call: the 21st createProcess, with 20 live PTYs in the
      // same backend process.
      const t0 = performance.now();
      await spawnOne();
      const createMs = performance.now() - t0;

      console.log(
        `\n[create_process_under_live_ptys] live_ptys=${LIVE_PTYS} ` +
          `21st createProcess=${createMs.toFixed(0)}ms (budget ${BUDGET_MS}ms)\n`,
      );

      expect(
        createMs,
        `21st createProcess took ${createMs.toFixed(0)}ms with ${LIVE_PTYS} live PTYs — ` +
          `event loop is oversubscribed by the PTY read/decode loops`,
      ).toBeLessThan(BUDGET_MS);
    } finally {
      // Best-effort: close every worker we spawned, then drop the instance.
      try {
        const { sdk } = await prepareCleanRealm(port);
        for (const id of spawned) {
          try {
            await sdk.apiClient.post(`${sdk.GRAPH_API_PREFIX}/agentic_process/${id}/close`, {});
          } catch {
            /* best-effort */
          }
        }
      } catch {
        /* realm already torn down */
      }
      await killInstance(name);
    }
  });
});
