/**
 * Simple PTY-launch latency guard under load.
 *
 *   1. setup load   — bring up N live claude PTYs on a fresh instance
 *   2. launch a PTY — createProcess(visible) and wait until its PTY is readable
 *                     (first output byte streams in = the worker is up)
 *   3. assert       — the launch+read completes in < 4s; FAIL otherwise
 *
 * The launch path is fast in isolation (~1s) but degrades as concurrent live
 * PTYs accumulate. Tune the load with LOAD_PTYS=<n>.
 *
 * Run: cd ui && LOAD_PTYS=80 npx vitest run --project long pty_launch_under_load
 */
import { describe, expect, it } from 'vitest';
import { stressDescribe } from './_stress_gate';
import { launchInstance, killInstance, prepareCleanRealm } from './_backend_lifecycle';

type SdkRealm = typeof import('@sdk');

const LOAD = Number(process.env.LOAD_PTYS) || 80;
const BUDGET_MS = 4000;
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][@-Z\\^_`a-z{|}~]/g;

stressDescribe('PTY launch readiness under load', () => {
  it(
    `launch a PTY + wait for read in < ${BUDGET_MS}ms under ${LOAD} live PTYs`,
    async () => {
      const name = 'pty-under-load';
      const port = await launchInstance(name);
      if (!port) {
        await killInstance(name);
        throw new Error(`${name} failed to launch / become healthy`);
      }
      const spawned: string[] = [];
      try {
        const { sdk, main } = await prepareCleanRealm(port);
        await main.initSdk();
        const cn = await sdk.ComputeNode.getById<InstanceType<SdkRealm['ComputeNode']>>('@local');
        if (!cn) throw new Error('No @local compute node after initSdk');

        const launchPty = async (watch: boolean) => {
          const p = await cn.createProcess(
            { workerType: 'claude_code', permissionMode: 'bypassPermissions' },
            { visible: true, watchProcess: watch },
          );
          spawned.push(p.id);
          return p;
        };

        // 1. setup load — N live claude PTYs
        for (let i = 0; i < LOAD; i++) await launchPty(false);

        // 2. launch a PTY + wait until it is readable (first output byte)
        const t0 = performance.now();
        const proc = await launchPty(true);

        // shell_id links asynchronously after createProcess returns — resolve it.
        // Poll with a RAW REST fetch, not AgenticProcess.getById: in this node
        // SDK realm getById serves the dataManager cache, which never reflects
        // the async shell-link (the WS entity update doesn't reach the cache
        // here), so shell_id reads null forever. A fresh GET sees the link — the
        // same raw-apiClient approach the dev-1 chat test uses. (realm-per-instance.)
        const procUrl = `${sdk.GRAPH_API_PREFIX}/${sdk.AgenticProcess.type}/${proc.id}`;
        let shellId = proc.shell_id;
        for (let i = 0; i < 80 && !shellId; i++) {
          await new Promise((r) => setTimeout(r, 100));
          shellId =
            ((await sdk.apiClient.get(procUrl).catch(() => null)) as { shell_id?: string } | null)?.shell_id ?? null;
        }
        if (!shellId) throw new Error('shell_id never linked');
        const shell = await sdk.Shell.getById<InstanceType<SdkRealm['Shell']>>(shellId);
        if (!shell) throw new Error(`Shell ${shellId} not found`);
        await shell.attachPty({});

        // "wait for read": first non-empty PTY output = the worker is up and readable.
        const dec = new TextDecoder('utf-8');
        const hardCap = BUDGET_MS + 6000; // let it overrun the budget so we can report the real number
        let readable = false;
        while (performance.now() - t0 < hardCap) {
          const txt = shell
            .getPtyChunks()
            .map((c) => dec.decode(c.data))
            .join('')
            .replace(ANSI_RE, '')
            .trim();
          if (txt.length > 0) {
            readable = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 50));
        }
        const elapsed = performance.now() - t0;
        console.log(`[pty_launch_under_load] load=${LOAD} launch+read=${elapsed.toFixed(0)}ms readable=${readable}`);

        // 3. fail if it took more than 4s
        expect(
          elapsed,
          `launch + wait-for-read took ${elapsed.toFixed(0)}ms under ${LOAD} live PTYs (readable=${readable})`,
        ).toBeLessThan(BUDGET_MS);
      } finally {
        // best-effort cleanup: close every worker we spawned, then drop the instance
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
          /* realm gone */
        }
        await killInstance(name);
      }
    },
    240_000,
  );
});
