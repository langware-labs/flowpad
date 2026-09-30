/**
 * Shell.runCommand / interrupt / Shell.forSnippet against a LIVE backend — the path the snippet
 * view's Run and Stop take in the browser: a real PTY, the backend's invisible start/end markers
 * read off the real WebSocket stream, a real Ctrl-C.
 *
 * Runs against the instance selected by FLOW_INSTANCE. Every shell made here is `close()`d.
 */

import { ComputeNode, Shell } from '@sdk';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { trackForCleanup, testEntityName } from '../_cleanup';
import { apiTestSetup, get_local_compute_node, getTestSignupInfo } from '../utils/test-utils';

describe('shell_run_command', () => {
  const info = getTestSignupInfo();
  let computeNode: ComputeNode;
  const created: Shell[] = [];

  beforeEach(async (context: any) => {
    await apiTestSetup(info, context.task.name);
    computeNode = await get_local_compute_node('run-command-node');
    await computeNode.setup();
  });

  afterEach(async () => {
    while (created.length) await created.pop()!.close().catch(() => undefined);
  });

  async function liveShell(): Promise<Shell> {
    const shell = Shell.create(computeNode, { name: testEntityName('shell') });
    await shell.save();
    trackForCleanup(shell);
    created.push(shell);
    await shell.ensureStarted({ cols: 120, rows: 30 });
    return shell;
  }

  it('resolves with the exit code and exactly what the command printed', async () => {
    const shell = await liveShell();
    const result = await shell.runCommand('echo run-command-ok; (exit 3)');
    expect(result.exitCode).toBe(3);
    expect(result.output.trim()).toBe('run-command-ok');
  });

  it('interrupt ends a running command with 130 and the terminal keeps answering', async () => {
    const shell = await liveShell();
    const run = shell.runCommand('sleep 30');
    await expect.poll(async () => (await shell.runState()).running_pid, { timeout: 5000 }).not.toBeNull();
    expect(await shell.interrupt()).toBe(true);
    expect((await run).exitCode).toBe(130);
    expect((await shell.runCommand('echo still-here')).output.trim()).toBe('still-here');
  });

  it('a snippet file has one terminal, found without being made before its first run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'snippet-term-'));
    const path = join(dir, 'hello.py');
    writeFileSync(path, '# %% flowpad:snippet\nprint("from-the-snippet")\n');
    expect(await Shell.findForSnippet(path)).toBeNull();
    const { shell, command } = await Shell.forSnippet(path);
    created.push(shell);
    expect((await Shell.findForSnippet(path))?.shell.id).toBe(shell.id);
    await shell.ensureStarted({ cols: 120, rows: 30 });
    const result = await shell.runCommand(command);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('from-the-snippet');
  });
});
