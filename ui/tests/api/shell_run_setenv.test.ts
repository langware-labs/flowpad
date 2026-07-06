/**
 * Shell.run() + Shell.setEnv() SDK wrapper tests (docs/interface/shell.md).
 *
 * Drives the two non-lifecycle Shell HTTP actions through the TS SDK against a
 * LIVE backend — no PTY needed (both are metadata / one-shot-subprocess paths):
 *   - `run`     → `{stdout, stderr, exit_code}` envelope, mapped to
 *                 `{stdout, stderr, exitCode}` by the wrapper.
 *   - `set-env` → persists env on the entity; a subsequent `run` sees the var,
 *                 which proves both the persist and the param mapping.
 *
 * Runs against the instance selected by FLOW_INSTANCE (own instance_ctl
 * instance). Each shell is created via the SDK, tracked, and `close()`d in
 * teardown (close deletes the entity + disk record).
 */

import { ComputeNode, Shell } from '@sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { trackForCleanup, testEntityName } from '../_cleanup';
import { apiTestSetup, get_local_compute_node, getTestSignupInfo } from '../utils/test-utils';

describe('shell_run_setenv', () => {
  const info = getTestSignupInfo();
  let computeNode: ComputeNode;
  const created: Shell[] = [];

  beforeEach(async (context: any) => {
    await apiTestSetup(info, context.task.name);
    computeNode = await get_local_compute_node('run-setenv-node');
    await computeNode.setup();
  });

  afterEach(async () => {
    while (created.length) {
      const shell = created.pop()!;
      await shell.close().catch(() => {/* best-effort teardown */});
    }
  });

  async function makeShell(): Promise<Shell> {
    const shell = Shell.create(computeNode, { name: testEntityName('shell') });
    await shell.save();
    trackForCleanup(shell);
    created.push(shell);
    return shell;
  }

  it('run returns {stdout, stderr, exitCode} for a successful command', async () => {
    const shell = await makeShell();
    const result = await shell.run('echo hello-from-run');
    expect(result.stdout).toContain('hello-from-run');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  }, 15000);

  it('run maps a non-zero exit code and captures stderr', async () => {
    const shell = await makeShell();
    const result = await shell.run('echo oops 1>&2; exit 3');
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('oops');
    expect(result.stdout).toBe('');
  }, 15000);

  it('setEnv persists env vars so a later run sees them', async () => {
    const shell = await makeShell();
    await shell.setEnv({ FLOW_TEST_VAR: 'flowpad-value' });

    // Persisted on the entity itself.
    expect(shell.env?.FLOW_TEST_VAR).toBe('flowpad-value');

    // And the one-shot subprocess run inherits it (proves the backend merged
    // the persisted env into the command environment).
    const result = await shell.run('echo "$FLOW_TEST_VAR"');
    expect(result.stdout).toContain('flowpad-value');
    expect(result.exitCode).toBe(0);
  }, 15000);

  it('setEnv merges rather than replacing prior vars', async () => {
    const shell = await makeShell();
    await shell.setEnv({ FIRST_VAR: 'one' });
    await shell.setEnv({ SECOND_VAR: 'two' });
    const result = await shell.run('echo "$FIRST_VAR:$SECOND_VAR"');
    expect(result.stdout).toContain('one:two');
  }, 15000);
});
