import { describe, it, expect } from 'vitest';
import { getWorkerMode, WorkerMode } from '@sdk';

/**
 * ``WorkerMode`` is derived from ``visible``:
 *   visible === true  → WorkerMode.Interactive
 *   visible === false → WorkerMode.CLI
 *   visible === undefined → WorkerMode.CLI (no attached PTY by default)
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
  it('returns Interactive when visible=true', () => {
    expect(getWorkerMode({ visible: true })).toBe(WorkerMode.Interactive);
  });

  it('returns CLI when visible=false', () => {
    expect(getWorkerMode({ visible: false })).toBe(WorkerMode.CLI);
  });

  it('returns CLI when visible is undefined', () => {
    expect(getWorkerMode({})).toBe(WorkerMode.CLI);
  });

  it('ignores other fields', () => {
    expect(
      getWorkerMode({
        visible: true,
        status: 'running',
        workerStatus: 'thinking',
        session_id: 'abc',
      }),
    ).toBe(WorkerMode.Interactive);
  });
});
