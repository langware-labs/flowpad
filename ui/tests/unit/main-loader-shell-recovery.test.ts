import { dataContext, ShellStatus } from '@sdk';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { filterTabs } from '@src/hooks/useActiveTerminals';
import { describeProcessStartError, resolveDefaultTab } from '@src/routes/loaders/main-loader';

function makeShell(id: string, status: string = ShellStatus.RUNNING) {
  return {
    id,
    status,
    tab_order: 0,
    name: null,
    collaboration_session_id: null,
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

function pickDefault(
  shells: any[],
  processes: any[],
  skips: { skipProcessIds?: Set<string>; skipShellIds?: Set<string> } = {},
) {
  const tabs = filterTabs(shells, processes, { visible: true });
  return resolveDefaultTab(tabs, {
    skipProcessIds: skips.skipProcessIds ?? new Set(),
    skipShellIds: skips.skipShellIds ?? new Set(),
  });
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

  it('picks the linked process tab when no recovery skip is active', () => {
    const shell = makeShell('shell-a');
    const process = makeProcess('proc-a', 'shell-a');

    const picked = pickDefault([shell], [process]);
    expect(picked?.shellId).toBe('shell-a');
    expect(picked?.agenticProcess?.id).toBe('proc-a');
  });

  it('skips the failed process shell and falls back to another alive shell', () => {
    const brokenShell = makeShell('shell-a');
    const fallbackShell = makeShell('shell-b');
    const process = makeProcess('proc-a', 'shell-a');
    dataContext.activeShellId = 'shell-a';

    const picked = pickDefault([brokenShell, fallbackShell], [process], {
      skipProcessIds: new Set(['proc-a']),
      skipShellIds: new Set(['shell-a']),
    });
    expect(picked?.shellId).toBe('shell-b');
    expect(picked?.agenticProcess).toBeUndefined();
  });

  it('picks the second process when the first is in the skip set', () => {
    const shellA = makeShell('shell-a');
    const shellB = makeShell('shell-b');
    const processA = makeProcess('proc-a', 'shell-a');
    const processB = makeProcess('proc-b', 'shell-b');

    const picked = pickDefault([shellA, shellB], [processA, processB], {
      skipProcessIds: new Set(['proc-a']),
      skipShellIds: new Set(['shell-a']),
    });
    expect(picked?.shellId).toBe('shell-b');
    expect(picked?.agenticProcess?.id).toBe('proc-b');
  });

  it('returns null when the only alive shell belongs to the skipped failed process', () => {
    const brokenShell = makeShell('shell-a');
    const process = makeProcess('proc-a', 'shell-a');

    const picked = pickDefault([brokenShell], [process], {
      skipProcessIds: new Set(['proc-a']),
      skipShellIds: new Set(['shell-a']),
    });
    expect(picked).toBeNull();
  });

  it('returns null when every visible process shell has already failed recovery', () => {
    const shellA = makeShell('shell-a');
    const shellB = makeShell('shell-b');
    const processA = makeProcess('proc-a', 'shell-a');
    const processB = makeProcess('proc-b', 'shell-b');

    const picked = pickDefault([shellA, shellB], [processA, processB], {
      skipProcessIds: new Set(['proc-a', 'proc-b']),
      skipShellIds: new Set(['shell-a', 'shell-b']),
    });
    expect(picked).toBeNull();
  });

  it('surfaces the PTY attach error instead of a generic terminated message', () => {
    const info = describeProcessStartError(new Error('PTY 123 not found for shell shell-a'));

    expect(info.title).toBe('Terminal reattach failed');
    expect(info.description).toContain('PTY 123 not found for shell shell-a');
  });
});
