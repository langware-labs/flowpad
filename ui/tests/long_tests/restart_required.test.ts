/**
 * End-to-end mirror of tests/long_tests/test_restart_required_ws.py — pure SDK.
 *
 * Drives every positive + negative scenario through the production
 * AgenticProcess SDK against the live backend at localhost:9008.
 * Real `proc.restart()` clears the flag (exercises the actual backend
 * lifecycle hook, not a test simulation).
 *
 * Updates flow back into the in-memory entity via the live WebSocket —
 * single-client recipient fallback delivers all DataOps without explicit
 * `watch()` (see resource_tracker:_resolve_recipients).
 */

import { AgenticProcess } from '@sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

const TIMEOUT = 90_000;
const POLL_MS = 50;
const POLL_BUDGET_MS = 10_000;

async function waitForEntity<T>(
  entity: T,
  predicate: (e: T) => boolean,
  label = '',
): Promise<void> {
  const deadline = Date.now() + POLL_BUDGET_MS;
  while (Date.now() < deadline) {
    if (predicate(entity)) return;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  throw new Error(`waitForEntity timed out: ${label}`);
}

/**
 * Create a process and bring it to status=RUNNING via the real backend
 * lifecycle. After ``start()`` the snapshot hash is captured and
 * ``restart_required`` is False — that's the post-start invariant we want.
 */
async function setupRunningProcess(): Promise<AgenticProcess> {
  const proc = await new AgenticProcess({}).save([]);
  await proc.start();
  await waitForEntity(
    proc,
    (p) =>
      p.status === ('running' as any) &&
      p.last_started_hash !== null &&
      p.restart_required === false,
    'process running with hash captured',
  );
  return proc;
}

const TRACKED: Array<[label: string, mutate: (p: AgenticProcess) => void]> = [
  ['cli_config.chrome',          (p) => { p.cli_config = { ...(p.cli_config ?? {}), chrome: true }; }],
  ['cli_config.debug',           (p) => { p.cli_config = { ...(p.cli_config ?? {}), debug: true }; }],
  ['cli_config.permission_mode', (p) => { p.cli_config = { ...(p.cli_config ?? {}), permission_mode: 'plan' }; }],
  ['cli_config.worktree',        (p) => { p.cli_config = { ...(p.cli_config ?? {}), worktree: true }; }],
  ['cli_config.verbose',         (p) => { p.cli_config = { ...(p.cli_config ?? {}), verbose: true }; }],
  ['cli_config.output_format',   (p) => { p.cli_config = { ...(p.cli_config ?? {}), output_format: 'stream-json' }; }],
  ['cli_config.model',           (p) => { p.cli_config = { ...(p.cli_config ?? {}), model: 'claude-opus-4-7' }; }],
  ['cli_config.effort',          (p) => { p.cli_config = { ...(p.cli_config ?? {}), effort: 'high' }; }],
  ['cli_config.print_mode',      (p) => { p.cli_config = { ...(p.cli_config ?? {}), print_mode: true }; }],
  ['cli_config.env_vars',        (p) => { p.cli_config = { ...(p.cli_config ?? {}), env_vars: { FOO: 'bar' } }; }],
  ['cli_config.agents_json',     (p) => { p.cli_config = { ...(p.cli_config ?? {}), agents_json: { x: { description: 'y' } } }; }],
  ['workdir',                    (p) => { p.workdir = '/tmp/restart_required_test'; }],
  ['additional_dirs',            (p) => { p.additional_dirs = [...(p.additional_dirs ?? []), '/tmp/extra_a']; }],
  ['embedded_agent_ids',         (p) => { p.embedded_agent_ids = [...(p.embedded_agent_ids ?? []), 'legacy_persona']; }],
  ['shell_mode',                 (p) => { p.shell_mode = !p.shell_mode; }],
];

const NEGATIVE: Array<[label: string, mutate: (p: AgenticProcess) => void]> = [
  ['name',            (p) => { p.name = 'renamed'; }],
  ['tags',            (p) => { p.tags = ['a', 'b']; }],
  ['labels',          (p) => { p.labels = ['x']; }],
  ['visible',         (p) => { p.visible = true; }],
  ['target_typeid_str', (p) => { p.target_typeid_str = 'markdown-deadbeef-dead-beef-dead-beefdeadbeef'; }],
  ['plan_path',       (p) => { p.plan_path = '/tmp/some-plan.md'; }],
];

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────

describe('AgenticProcess.restart_required (live SDK + WS, mirrors test_restart_required_ws.py)', () => {
  const cleanup: AgenticProcess[] = [];

  beforeEach(async (ctx: any) => {
    await apiTestSetup(getTestSignupInfo(), ctx.task.name);
  });

  afterEach(async () => {
    while (cleanup.length) {
      const p = cleanup.pop()!;
      try { await p.exit(); } catch { /* ignore */ }
      try { await p.delete(); } catch { /* ignore */ }
    }
  });

  it('full positive cycle: every tracked field flips True; real restart clears it', async () => {
    const proc = await setupRunningProcess();
    cleanup.push(proc);

    for (const [label, mutate] of TRACKED) {
      mutate(proc);
      await proc.save();
      await waitForEntity(
        proc,
        (p) => p.restart_required === true,
        `${label}: flip ON`,
      );
      expect(proc.restart_required, label).toBe(true);

      // Real restart through the SDK — backend's start() success path captures
      // a fresh snapshot and clears restart_required.
      await proc.restart();
      await waitForEntity(
        proc,
        (p) => p.restart_required === false,
        `${label}: cleared by restart`,
      );
      expect(proc.restart_required, `${label}: cleared`).toBe(false);
    }
  }, TIMEOUT);

  it.each(NEGATIVE)('non-tracked field %s does not flip', async (label, mutate) => {
    const proc = await setupRunningProcess();
    cleanup.push(proc);

    mutate(proc);
    await proc.save();
    // After save() returns, the SDK has already deepAssigned the server's
    // response into the entity (no need to wait for WS). Just assert.
    expect(proc.restart_required, label).toBe(false);
  }, TIMEOUT);

  it('not-running gate blocks the flip', async () => {
    // Process not started — status defaults to NEW. last_started_hash stays null.
    // Even mutating a tracked field must NOT flip the flag because the gate is
    // `status == RUNNING && last_started_hash`.
    const proc = await new AgenticProcess({}).save([]);
    cleanup.push(proc);

    proc.cli_config = { chrome: true };
    await proc.save();
    await waitForEntity(
      proc,
      (p) => (p.cli_config as any)?.chrome === true,
      'tracked mutation reflected',
    );
    expect(proc.restart_required, 'NEW status — flag should not flip').toBe(false);
  }, TIMEOUT);

  it('external set via API: direct attribute assignment + save flips in either direction', async () => {
    const proc = await new AgenticProcess({}).save([]);
    cleanup.push(proc);

    proc.restart_required = true;
    await proc.save();
    await waitForEntity(proc, (p) => p.restart_required === true, 'external ON');
    expect(proc.restart_required).toBe(true);

    proc.restart_required = false;
    await proc.save();
    await waitForEntity(proc, (p) => p.restart_required === false, 'external OFF');
    expect(proc.restart_required).toBe(false);
  }, TIMEOUT);

  it('no-op save (metadata-only) does not flip', async () => {
    const proc = await setupRunningProcess();
    cleanup.push(proc);

    proc.name = 'noop';
    await proc.save();
    await waitForEntity(proc, (p) => p.name === 'noop', 'noop reflected');
    expect(proc.restart_required, 'no-op save').toBe(false);
  }, TIMEOUT);

  it('two consecutive tracked mutations keep flag True (no flicker)', async () => {
    const proc = await setupRunningProcess();
    cleanup.push(proc);

    proc.cli_config = { ...(proc.cli_config ?? {}), chrome: true };
    await proc.save();
    await waitForEntity(proc, (p) => p.restart_required === true, 'first flip');

    proc.cli_config = { ...(proc.cli_config ?? {}), debug: true };
    await proc.save();
    await waitForEntity(
      proc,
      (p) => (p.cli_config as any)?.debug === true,
      'second mutation reflected',
    );
    expect(proc.restart_required, 'still True after second mutation').toBe(true);
  }, TIMEOUT);
});
