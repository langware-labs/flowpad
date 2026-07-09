import { describe, it, expect } from 'vitest';
import { getWorkerMode, WorkerMode } from '@sdk';

/**
 * ``WorkerMode`` is derived from the *transport* ``pty_mode`` (NOT tab ``visible``):
 *   pty_mode === true  → WorkerMode.Interactive
 *   pty_mode === false → WorkerMode.CLI
 *   pty_mode undefined → falls back to ``visible`` (visible=true ⟹ pty_mode=true)
 *
 * The same rule is mirrored on the Python side in
 * ``flow_sdk/builtin/agentic_process/status_predicates.py::get_worker_mode``.
 */

describe('WorkerMode', () => {
  it('has exactly two canonical values', () => {
    expect(Object.values(WorkerMode).sort()).toEqual(['cli', 'interactive']);
  });

  it('wire values are stable', () => {
    expect(WorkerMode.Interactive).toBe('interactive');
    expect(WorkerMode.CLI).toBe('cli');
  });
});

describe('getWorkerMode', () => {
  it('returns Interactive when pty_mode=true', () => {
    expect(getWorkerMode({ pty_mode: true })).toBe(WorkerMode.Interactive);
  });

  it('returns CLI when pty_mode=false', () => {
    expect(getWorkerMode({ pty_mode: false })).toBe(WorkerMode.CLI);
  });

  it('hidden live PTY (visible=false, pty_mode=true) is Interactive', () => {
    // The transport wins over tab visibility — this is the row the old
    // visible-keyed derivation got wrong.
    expect(getWorkerMode({ visible: false, pty_mode: true })).toBe(WorkerMode.Interactive);
  });

  it('CLI stays CLI even if a tab shows it (visible=true, pty_mode=false)', () => {
    expect(getWorkerMode({ visible: true, pty_mode: false })).toBe(WorkerMode.CLI);
  });

  it('falls back to visible when pty_mode is absent', () => {
    expect(getWorkerMode({ visible: true })).toBe(WorkerMode.Interactive);
    expect(getWorkerMode({ visible: false })).toBe(WorkerMode.CLI);
  });

  it('returns CLI when both pty_mode and visible are undefined', () => {
    expect(getWorkerMode({})).toBe(WorkerMode.CLI);
  });

  it('ignores unrelated fields', () => {
    expect(
      getWorkerMode({
        pty_mode: true,
        status: 'running',
        workerStatus: 'thinking',
        session_id: 'abc',
      }),
    ).toBe(WorkerMode.Interactive);
  });
});
