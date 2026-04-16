import { dataContext, ShellStatus } from '@sdk';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { describeProcessStartError, resolveDefaultShell } from '@src/routes/loaders/main-loader';

function makeShell(id: string, status: string = ShellStatus.RUNNING) {
  return {
    id,
    status,
    dockPointer: { pointer: `shell-${id}` },
  } as any;
}

function makeProcess(id: string, shellId: string, status = 'starting') {
  return {
    id,
    shell_id: shellId,
    status,
    dockPointer: { pointer: `agentic_process-${id}` },
  } as any;
}

describe('main-loader shell recovery', () => {
  let originalActiveShellId = '';

  beforeEach(() => {
    originalActiveShellId = dataContext.activeShellId;
    dataContext.activeShellId = '';
  });

  afterEach(() => {
    dataContext.activeShellId = originalActiveShellId;
  });

  it('keeps the normal shell-to-process redirect when no recovery skip is active', () => {
    const shell = makeShell('shell-a');
    const process = makeProcess('proc-a', 'shell-a');

    expect(resolveDefaultShell([shell], [process])).toBe('/dock/shell/agentic_process-proc-a');
  });

  it('skips the failed process shell and falls back to another alive shell', () => {
    const brokenShell = makeShell('shell-a');
    const fallbackShell = makeShell('shell-b');
    const process = makeProcess('proc-a', 'shell-a');
    dataContext.activeShellId = 'shell-a';

    expect(
      resolveDefaultShell([brokenShell, fallbackShell], [process], {
        skipProcessIds: new Set(['proc-a']),
        skipShellIds: new Set(['shell-a']),
      }),
    ).toBe('/dock/shell/shell-shell-b');
  });

  it('preserves accumulated recovery skips when redirecting into another process', () => {
    const shellA = makeShell('shell-a');
    const shellB = makeShell('shell-b');
    const processA = makeProcess('proc-a', 'shell-a');
    const processB = makeProcess('proc-b', 'shell-b');

    expect(
      resolveDefaultShell([shellA, shellB], [processA, processB], {
        skipProcessIds: new Set(['proc-a']),
        skipShellIds: new Set(['shell-a']),
      }),
    ).toBe('/dock/shell/agentic_process-proc-b?skip_process_id=proc-a&skip_shell_id=shell-a');
  });

  it('returns null when the only alive shell belongs to the skipped failed process', () => {
    const brokenShell = makeShell('shell-a');
    const process = makeProcess('proc-a', 'shell-a');

    expect(
      resolveDefaultShell([brokenShell], [process], {
        skipProcessIds: new Set(['proc-a']),
        skipShellIds: new Set(['shell-a']),
      }),
    ).toBeNull();
  });

  it('returns null when every visible process shell has already failed recovery', () => {
    const shellA = makeShell('shell-a');
    const shellB = makeShell('shell-b');
    const processA = makeProcess('proc-a', 'shell-a');
    const processB = makeProcess('proc-b', 'shell-b');

    expect(
      resolveDefaultShell([shellA, shellB], [processA, processB], {
        skipProcessIds: new Set(['proc-a', 'proc-b']),
        skipShellIds: new Set(['shell-a', 'shell-b']),
      }),
    ).toBeNull();
  });

  it('surfaces the PTY attach error instead of a generic terminated message', () => {
    const info = describeProcessStartError(new Error('PTY 123 not found for shell shell-a'));

    expect(info.title).toBe('Terminal reattach failed');
    expect(info.description).toContain('PTY 123 not found for shell shell-a');
  });
});
