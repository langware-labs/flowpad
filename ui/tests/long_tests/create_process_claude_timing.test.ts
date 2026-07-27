/**
 * createProcess(claude) timing — on a FRESH instance.
 *
 * The simplest possible "how long does it take to spin up a claude worker?"
 * benchmark: launch a brand-new, isolated backend instance, run the real
 * app-startup `initSdk()` against it, then time a single
 * `ComputeNode.createProcess({ workerType: 'claude_code' })` — the server-side
 * spawn of the AgenticProcess + Shell + claude PTY.
 *
 * Isolation mirrors `init_sdk_bench.test.ts`: a fresh disposable instance
 * (`launchInstance`) + a fresh, owned SDK realm (`createSdkRealm`, scoped to
 * that backend and explicitly disposed).
 *
 * This only TIMES createProcess — it does not execute an instruction. The
 * worker is closed and the instance killed in `finally`.
 *
 * Run: cd ui && npx vitest run --project long create_process_claude_timing
 */
import { describe, expect, it } from 'vitest';
import { stressDescribe } from './_stress_gate';
import { launchInstance, killInstance, prepareCleanRealm } from './_backend_lifecycle';
import type { OwnedSdkMainRealm } from '../_sdk_realm';

type SdkRealm = typeof import('@sdk');

stressDescribe('createProcess(claude) timing on a fresh instance', () => {
  it('launch fresh instance → createProcess(claude_code) → time it', async () => {
    const name = 'cp-claude-1';

    const tLaunch = performance.now();
    const port = await launchInstance(name);
    const launchMs = performance.now() - tLaunch;
    if (!port) {
      await killInstance(name);
      throw new Error(`${name} failed to launch / become healthy`);
    }

    let realm: OwnedSdkMainRealm | undefined;
    try {
      // Real app-startup init against the fresh backend (errors are swallowed inside).
      realm = await prepareCleanRealm(port);
      const { sdk, main } = realm;
      await main.initSdk();
      expect((window as Record<string, unknown>).appReady, 'initSdk should complete').toBe(true);

      const cn = await sdk.ComputeNode.getById<InstanceType<SdkRealm['ComputeNode']>>('@local');
      if (!cn) throw new Error('No @local compute node after initSdk');

      // The measured call: server-side spawn of AgenticProcess + Shell + claude PTY.
      const tCreate = performance.now();
      const proc = await cn.createProcess(
        { workerType: 'claude_code', permissionMode: 'bypassPermissions' },
        { visible: true, watchProcess: false },
      );
      const createMs = performance.now() - tCreate;

      console.log(
        `\n[create_process_claude_timing] launch=${(launchMs / 1000).toFixed(1)}s  ` +
          `createProcess(claude_code)=${createMs.toFixed(0)}ms  ` +
          `(process=${proc.id} shell=${proc.shell_id})\n`,
      );

      expect(proc.id, 'createProcess should return a process id').toBeTruthy();
      // shell_id is populated asynchronously once the PTY spawns; it's logged above
      // but isn't a reliable synchronous signal, so the timing isn't gated on it.

      // Clean up the spawned worker so we don't leak a claude PTY.
      try {
        await sdk.apiClient.post(`${sdk.GRAPH_API_PREFIX}/agentic_process/${proc.id}/close`, {});
      } catch {
        /* best-effort */
      }
    } finally {
      realm?.dispose();
      await killInstance(name);
    }
  });
});
