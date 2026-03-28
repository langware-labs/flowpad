/**
 * Regression test: AgenticProcess.spawn() → process.open() should succeed.
 *
 * Currently FAILS with "Request timeout" because spawn() creates AgenticProcess
 * without compute_node_id. See RCA below.
 */

import { AgenticProcess, ClaudeCliOptions, ConnectionManager } from '@sdk';
import { describe, it, expect, beforeEach } from 'vitest';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

describe('AgenticProcess spawn regression', () => {
  const info = getTestSignupInfo();

  beforeEach(async (ctx: any) => {
    await apiTestSetup(info, ctx.task.name);
    await waitFor(() => ConnectionManager.getInstance().connected, 5000);
  });

  it('process.open() succeeds after spawn() creates the process', async () => {
    const cliConfig = new ClaudeCliOptions({ permission_mode: 'bypassPermissions' });

    const process = await new AgenticProcess({
      cli_config: cliConfig.toJson(),
      context_data: {},
    }).save();

    const { shell } = await process.open({ instruction: 'echo hello', ptyTimeout: 3000 });
    expect(shell).toBeDefined();
    expect(shell.id).toBeTruthy();
  }, 10000);
});

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}
