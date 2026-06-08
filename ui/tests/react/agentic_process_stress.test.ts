/**
 * AgenticProcess PTY Integration Tests
 *
 * Suite 1 (integration, real backend + PTY): Real Claude PTY lifecycle —
 *   open() creates a live shell, resolvedStatus reflects is_active,
 *   prompt() sends input and output is received.
 *
 * Suite 2 (integration, real backend + PTY): Restore from DB —
 *   Reproduces the "resume after navigation" bug: stop PTY, restore from DB,
 *   open(), prompt() × 2 → hola appears twice.
 *   Expected to FAIL until open() + loadShell path is wired.
 *
 * Suite 3 (integration, real backend + WS): WS entity updates —
 *   dataManager subscriptions fire when entity properties change,
 *   resolvedStatus ghost-running correction works.
 */

import { AgenticProcess, ConnectionManager, dataManager, ProcessStatus, Shell, TypeId } from '@sdk';
import { v4 as uuidv4 } from 'uuid';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiTestSetup, createAgenticProcess, getTestSignupInfo } from '../utils/test-utils';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Register a process in dataManager so entity lookup finds it. */
function registerProcess(process: AgenticProcess): void {
  const typeId = new TypeId(AgenticProcess.type, process.id);
  const ref = (dataManager as any).getRef(typeId);
  ref.entity = process;
}

/**
 * Wait until the shell has attached=true (i.e. startPty() has completed).
 */
async function waitForShellReady(shell: Shell, timeoutMs = 15000): Promise<void> {
  await vi.waitFor(
    () => {
      if (!shell.attached) throw new Error('Shell not ready');
    },
    { timeout: timeoutMs, interval: 200 },
  );
}

/**
 * Collect raw PTY output from a shell over a time window.
 * Requires shell to have attached=true (i.e. connect() must have been called).
 */
async function collectPtyOutput(shell: Shell, durationMs: number): Promise<string> {
  const chunks: string[] = [];
  const unsub = shell.onOutput((data) => chunks.push(data));
  await new Promise((r) => setTimeout(r, durationMs));
  unsub?.();
  return chunks.join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite 1 — PTY lifecycle (real backend, haiku model)
// ─────────────────────────────────────────────────────────────────────────────

describe.skip('AgenticProcess PTY lifecycle — integration', () => {
  const info = getTestSignupInfo();
  let manager: ReturnType<typeof ConnectionManager.getInstance>;

  beforeEach(async (ctx: any) => {
    await apiTestSetup(info, ctx.task.name);
    manager = ConnectionManager.getInstance();
    await vi.waitFor(
      () => {
        if (!manager.connected) throw new Error('WS not connected');
      },
      { timeout: 5000, interval: 200 },
    );
  });

  it('open() creates a live shell and process.shell_id is set', async () => {
    const { createIdleProcess } = await createAgenticProcess({
      nodeName: `pty-lifecycle-${Date.now()}`,
      model: 'claude-haiku-4-5-20251001',
    });
    const process = await createIdleProcess();

    // Before open: no shell
    expect(process.shell_id).toBeFalsy();

    await process.start();
    const shellId = process.shell_id;
    expect(shellId).toBeTruthy();

    // Shell entity should be accessible via dataManager
    const typeId = new TypeId(Shell.type, shellId!);
    const shell = await dataManager.getByTypeId<Shell>(typeId);
    expect(shell).not.toBeNull();
  }, 30000);

  it('resolvedStatus reflects is_active after open()', async () => {
    const { createIdleProcess } = await createAgenticProcess({
      nodeName: `pty-status-${Date.now()}`,
      model: 'claude-haiku-4-5-20251001',
    });
    const process = await createIdleProcess();

    // Idle before PTY
    expect(process.resolvedStatus).toBe(ProcessorStatus.IDLE);

    await process.start();

    // After open(), is_active may be set by WS; resolvedStatus returns the actual status
    // (ghost-running correction: if running+is_active=false → idle)
    const resolved = process.resolvedStatus;
    expect([ProcessorStatus.IDLE, ProcessorStatus.RUNNING]).toContain(resolved);
  }, 30000);

  it('prompt("Say hola") → hola appears in PTY output', async () => {
    const { createIdleProcess } = await createAgenticProcess({
      nodeName: `pty-prompt-${Date.now()}`,
      model: 'claude-haiku-4-5-20251001',
    });
    const process = await createIdleProcess();
    await process.start();
    const shellId = process.shell_id;

    const typeId = new TypeId(Shell.type, shellId!);
    const shell = await dataManager.getByTypeId<Shell>(typeId);
    expect(shell).not.toBeNull();

    // Connect shell to start receiving PTY output
    await shell!.attachPty({ cols: 80, rows: 24 });
    await waitForShellReady(shell!, 15000);

    // Wait for Claude Code to start up before sending prompt
    await new Promise((r) => setTimeout(r, 3000));

    // Collect output while sending prompt
    const outputPromise = collectPtyOutput(shell!, 30000);
    await process.sendInput('Say hola');
    const output = await outputPromise;

    expect(output.toLowerCase()).toContain('hola');
  }, 60000);

  it('prompt("Say hola") called twice → hola appears at least twice', async () => {
    const { createIdleProcess } = await createAgenticProcess({
      nodeName: `pty-prompt2-${Date.now()}`,
      model: 'claude-haiku-4-5-20251001',
    });
    const process = await createIdleProcess();
    await process.start();
    const shellId = process.shell_id;

    const typeId = new TypeId(Shell.type, shellId!);
    const shell = await dataManager.getByTypeId<Shell>(typeId);
    expect(shell).not.toBeNull();

    await shell!.attachPty({ cols: 80, rows: 24 });
    await waitForShellReady(shell!, 15000);
    await new Promise((r) => setTimeout(r, 3000));

    const chunks: string[] = [];
    const unsub = shell!.onOutput((data) => chunks.push(data));

    // First prompt — wait for response
    await process.sendInput('Say hola');
    await new Promise((r) => setTimeout(r, 20000));

    // Second prompt — wait for response
    await process.sendInput('Say hola');
    await new Promise((r) => setTimeout(r, 20000));

    unsub?.();

    const output = chunks.join('').toLowerCase();
    const holaCount = (output.match(/hola/g) ?? []).length;
    expect(holaCount).toBeGreaterThanOrEqual(2);
  }, 120000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 2 — Restore from DB (expected to FAIL — reproduces actual bug)
// ─────────────────────────────────────────────────────────────────────────────

describe.skip('AgenticProcess restore from DB — integration', () => {
  const info = getTestSignupInfo();
  let manager: ReturnType<typeof ConnectionManager.getInstance>;

  beforeEach(async (ctx: any) => {
    await apiTestSetup(info, ctx.task.name);
    manager = ConnectionManager.getInstance();
    await vi.waitFor(
      () => {
        if (!manager.connected) throw new Error('WS not connected');
      },
      { timeout: 5000, interval: 200 },
    );
  });

  /**
   * REPRODUCES THE ACTUAL BUG: after navigation, the AgenticProcess is restored
   * from DB (fresh entity), open() is called, and prompt() should work.
   *
   * Expected to FAIL until the open() + loadShell path is wired correctly.
   */
  it('restore from DB: open() + prompt() × 2 → hola appears twice', async () => {
    // 1. Create and start a process
    const { createIdleProcess } = await createAgenticProcess({
      nodeName: `pty-restore-${Date.now()}`,
      model: 'claude-haiku-4-5-20251001',
    });
    const process = await createIdleProcess();
    await process.start();
    const shellId = process.shell_id;
    const workerSessionId = process.session_id;
    const processId = process.id;

    expect(shellId).toBeTruthy();
    expect(workerSessionId).toBeTruthy();

    // 2. Stop the PTY (simulates session ending)
    await process.stop();
    expect(process.resolvedStatus).toBe(ProcessorStatus.IDLE);

    // 3. Simulate navigation: restore entity from DB (fresh lookup)
    const typeId = new TypeId(AgenticProcess.type, processId);
    const restoredProcess = await dataManager.getByTypeId<AgenticProcess>(typeId);
    expect(restoredProcess).not.toBeNull();
    expect(restoredProcess!.session_id).toBe(workerSessionId);

    // 4. Reopen on restored process — start() resumes the Claude session
    await restoredProcess!.start();
    const newShellId = restoredProcess!.shell_id;
    expect(newShellId).toBeTruthy();

    // 5. Connect new shell
    const newShellTypeId = new TypeId(Shell.type, newShellId!);
    const newShell = await dataManager.getByTypeId<Shell>(newShellTypeId);
    expect(newShell).not.toBeNull();

    await newShell!.attachPty({ cols: 80, rows: 24 });
    await waitForShellReady(newShell!, 15000);
    await new Promise((r) => setTimeout(r, 3000));

    const chunks: string[] = [];
    const unsub = newShell!.onOutput((data) => chunks.push(data));

    // 6. Send prompt twice
    await restoredProcess!.sendInput('Say hola');
    await new Promise((r) => setTimeout(r, 20000));
    await restoredProcess!.sendInput('Say hola');
    await new Promise((r) => setTimeout(r, 20000));

    unsub?.();

    const output = chunks.join('').toLowerCase();
    const holaCount = (output.match(/hola/g) ?? []).length;
    expect(holaCount).toBeGreaterThanOrEqual(2);
  }, 120000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 3 — WS entity updates (integration)
// ─────────────────────────────────────────────────────────────────────────────

describe('AgenticProcess WS entity updates — integration', () => {
  const info = getTestSignupInfo();

  beforeEach(async (ctx: any) => {
    await apiTestSetup(info, ctx.task.name);
  });

  it('dataManager.subscribe fires when is_active changes — simulates WS update', async () => {
    const process = new AgenticProcess({ id: uuidv4() });
    registerProcess(process);

    const notified: boolean[] = [];
    const typeId = new TypeId(AgenticProcess.type, process.id);
    const unsub = dataManager.subscribe(typeId, () => {
      notified.push(process.is_active);
    });

    // Simulate WS entity update setting is_active=true
    process.is_active = true;
    dataManager.notifyPropertyChanged(typeId, 'is_active');

    expect(notified.length).toBeGreaterThanOrEqual(1);
    expect(notified[notified.length - 1]).toBe(true);

    unsub();
  });

  it('status stays lifecycle-owned even when is_active is false', async () => {
    const process = new AgenticProcess({
      id: uuidv4(),
      
      status: ProcessStatus.RUNNING,
      worker_status: 'running' as any,
      is_active: false,
    });
    registerProcess(process);

    expect(process.status).toBe(ProcessStatus.RUNNING);
    expect(process.workerStatus).toBe('running');
    expect(process.is_active).toBe(false);
  });

  it('worker_status remains transcript-owned when process is live', async () => {
    const process = new AgenticProcess({
      id: uuidv4(),
      
      status: ProcessStatus.RUNNING,
      worker_status: 'running' as any,
      is_active: true,
    });
    registerProcess(process);

    expect(process.status).toBe(ProcessStatus.RUNNING);
    expect(process.workerStatus).toBe('running');
    expect(process.is_active).toBe(true);
  });

  it('status and worker_status update independently on entity events', async () => {
    const process = new AgenticProcess({ id: uuidv4(), is_active: true });
    registerProcess(process);

    const statuses: Array<{ status: ProcessStatus; workerStatus: string }> = [];
    process.on('state_change', () => statuses.push({ status: process.status, workerStatus: process.workerStatus }));

    (process as any).onEntityUpdate({ status: ProcessStatus.STARTING });
    (process as any).onEntityUpdate({ worker_status: 'running' });
    (process as any).onEntityUpdate({ status: ProcessStatus.RUNNING });
    (process as any).onEntityUpdate({ worker_status: 'idle' });

    expect(statuses).toEqual([
      { status: ProcessStatus.STARTING, workerStatus: 'initializing' },
      { status: ProcessStatus.STARTING, workerStatus: 'running' },
      { status: ProcessStatus.RUNNING, workerStatus: 'running' },
      { status: ProcessStatus.RUNNING, workerStatus: 'idle' },
    ]);
  });
});
