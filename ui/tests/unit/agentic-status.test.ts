import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  classifyExecutionMode,
  ExecutionMode,
  getDisplayStatus,
  hasWorkerStarted,
  isProcessActive,
  isProcessRunning,
  isProcessStartable,
  isReadyForInput,
  isWorkerRunning,
  isWorkerTerminal,
  ProcessStatus,
  supportedExecutionModes,
  WorkerStatus,
} from '@sdk';

/**
 * Canonical status contract tests.
 *
 * These tests validate the two-axis status model surfaced by
 * ``ts_sdk/src/process/agentic-types.ts``:
 *
 *   ProcessStatus — app/user-level lifecycle (6 values, stored, explicit writers)
 *   WorkerStatus  — expert-level worker state (12 values, derived, not stored)
 *
 * Set parity (WORKER_RUNNING_STATUSES / WORKER_TERMINAL_STATUSES) is enforced
 * against the shared fixture ``test_fixtures/status_sets.json`` — the same file
 * the Python ``test_running_set_matches_spec`` test loads. Editing one side
 * without updating the other breaks both tests.
 */

// ─── Shared fixture ──────────────────────────────────────────────────────────

interface StatusSetsFixture {
  worker_running: string[];
  worker_terminal: string[];
  worker_ready_for_input: string[];
  worker_execution_error: string[];
  process_running: string[];
  process_startable: string[];
}

const FIXTURE_PATH = resolve(__dirname, '../../../test_fixtures/status_sets.json');
const fixture: StatusSetsFixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8'));

// ─── ProcessStatus wire values ───────────────────────────────────────────────

describe('ProcessStatus', () => {
  it('has exactly 6 canonical values', () => {
    expect(Object.values(ProcessStatus).sort()).toEqual(
      ['failed', 'new', 'running', 'starting', 'stopped', 'stopping'].sort(),
    );
  });

  it('wire value for RUNNING is "running" (renamed from "live")', () => {
    expect(ProcessStatus.RUNNING).toBe('running');
    expect((ProcessStatus as Record<string, unknown>).LIVE).toBeUndefined();
  });

  it.each([
    [ProcessStatus.STARTING, true],
    [ProcessStatus.RUNNING, true],
    [ProcessStatus.STOPPING, true],
    [ProcessStatus.NEW, false],
    [ProcessStatus.STOPPED, false],
    [ProcessStatus.FAILED, false],
  ])('isProcessRunning(%s) == %s', (status, expected) => {
    expect(isProcessRunning(status)).toBe(expected);
  });

  it('isProcessActive is a deprecation alias of isProcessRunning', () => {
    for (const status of Object.values(ProcessStatus)) {
      expect(isProcessActive(status)).toBe(isProcessRunning(status));
    }
  });

  it.each([
    [ProcessStatus.NEW, true],
    [ProcessStatus.STOPPED, true],
    [ProcessStatus.FAILED, true],
    [ProcessStatus.STARTING, false],
    [ProcessStatus.RUNNING, false],
    [ProcessStatus.STOPPING, false],
  ])('isProcessStartable(%s) == %s', (status, expected) => {
    expect(isProcessStartable(status)).toBe(expected);
  });
});

// ─── WorkerStatus wire values ────────────────────────────────────────────────

describe('WorkerStatus', () => {
  it('has exactly 14 canonical values (13 post-consolidation + pending_user)', () => {
    expect(Object.values(WorkerStatus).sort()).toEqual(
      [
        'initializing',
        'idle',
        'working',
        'thinking',
        'tool_call',
        'tool_running',
        'complete',
        'interrupted',
        'inactive',
        // Backend pending_user projection mirrored into TS (7659daf9);
        // deliberately in NO helper set — see the enum doc comment.
        'pending_user',
        'error',
        'api_error',
        'api_timeout',
        'unknown',
      ].sort(),
    );
  });

  it.each(['NEW', 'INIT', 'EMPTY', 'PAUSED', 'STEPPING', 'RUNNING'])(
    'removed value %s is not present',
    (removed) => {
      expect((WorkerStatus as Record<string, unknown>)[removed]).toBeUndefined();
    },
  );

  it('INITIALIZING replaces INIT + EMPTY', () => {
    expect(WorkerStatus.INITIALIZING).toBe('initializing');
  });

  it('UNKNOWN replaces the old RUNNING fallback', () => {
    expect(WorkerStatus.UNKNOWN).toBe('unknown');
  });
});

// ─── Set parity against shared fixture ───────────────────────────────────────

describe('set parity (vs test_fixtures/status_sets.json)', () => {
  it('WORKER_RUNNING_STATUSES matches fixture byte-for-byte', () => {
    const actual = Object.values(WorkerStatus).filter((s) => isWorkerRunning(s as WorkerStatus));
    expect(new Set(actual)).toEqual(new Set(fixture.worker_running));
  });

  it('WORKER_TERMINAL_STATUSES matches fixture byte-for-byte', () => {
    const actual = Object.values(WorkerStatus).filter((s) => isWorkerTerminal(s as WorkerStatus));
    expect(new Set(actual)).toEqual(new Set(fixture.worker_terminal));
  });

  it('process_running fixture matches isProcessRunning', () => {
    const actual = Object.values(ProcessStatus).filter((s) => isProcessRunning(s as ProcessStatus));
    expect(new Set(actual)).toEqual(new Set(fixture.process_running));
  });

  it('process_startable fixture matches isProcessStartable', () => {
    const actual = Object.values(ProcessStatus).filter((s) => isProcessStartable(s as ProcessStatus));
    expect(new Set(actual)).toEqual(new Set(fixture.process_startable));
  });

  it('READY_WORKER_STATUSES matches fixture worker_ready_for_input', () => {
    // Re-derive via isReadyForInput (the module-private READY_WORKER_STATUSES is
    // not exported): every WorkerStatus that reads ready on a RUNNING process is
    // exactly the fixture set. Pins the send-prompt gate to the same
    // {idle, complete, interrupted} literal the Python
    // test_ready_for_input_set_matches_spec asserts against _READY_WORKER_STATES.
    const actual = Object.values(WorkerStatus).filter((s) =>
      isReadyForInput({ status: ProcessStatus.RUNNING, workerStatus: s as WorkerStatus }),
    );
    expect(new Set(actual)).toEqual(new Set(fixture.worker_ready_for_input));
  });

  it('ERROR_WORKER_STATUSES matches fixture worker_execution_error', () => {
    // Re-derive via classifyExecutionMode rather than importing the private set:
    // any RUNNING worker whose status classifies as Error must be in the fixture.
    const actual = Object.values(WorkerStatus).filter(
      (s) =>
        classifyExecutionMode({ status: ProcessStatus.RUNNING, workerStatus: s as WorkerStatus }) ===
        ExecutionMode.Error,
    );
    expect(new Set(actual)).toEqual(new Set(fixture.worker_execution_error));
  });
});

// ─── classifyExecutionMode truth table ───────────────────────────────────────

describe('classifyExecutionMode', () => {
  it('returns null for non-live lifecycle states', () => {
    for (const s of [
      ProcessStatus.NEW,
      ProcessStatus.STOPPING,
      ProcessStatus.STOPPED,
      ProcessStatus.FAILED,
    ]) {
      expect(classifyExecutionMode({ status: s, visible: true })).toBeNull();
      expect(classifyExecutionMode({ status: s, visible: false })).toBeNull();
    }
  });

  it.each([ProcessStatus.RUNNING, ProcessStatus.STARTING])(
    'live %s + visible=true → Interactive',
    (s) => {
      expect(classifyExecutionMode({ status: s, visible: true })).toBe(ExecutionMode.Interactive);
    },
  );

  it.each([ProcessStatus.RUNNING, ProcessStatus.STARTING])(
    'live %s + visible=false → Background',
    (s) => {
      expect(classifyExecutionMode({ status: s, visible: false })).toBe(ExecutionMode.Background);
    },
  );

  // An error worker_status classifies as Error regardless of visible — over PTY
  // (visible=true) AND CLI (visible=false, no PID needed).
  it.each(
    [WorkerStatus.ERROR, WorkerStatus.API_TIMEOUT, WorkerStatus.INACTIVE].flatMap((w) =>
      [true, false].map((visible) => [w, visible] as const),
    ),
  )('error worker_status=%s wins over visible=%s → Error', (w, visible) => {
    expect(
      classifyExecutionMode({ status: ProcessStatus.RUNNING, visible, workerStatus: w }),
    ).toBe(ExecutionMode.Error);
  });

  it('PTY with dead PID → Error', () => {
    expect(
      classifyExecutionMode({ status: ProcessStatus.RUNNING, visible: true, pidAlive: false }),
    ).toBe(ExecutionMode.Error);
  });

  it('CLI with no PID liveness is not forced to Error by dead-PID rule', () => {
    // pidAlive undefined → rule 2 never fires; a healthy CLI stays Background.
    expect(
      classifyExecutionMode({ status: ProcessStatus.RUNNING, visible: false }),
    ).toBe(ExecutionMode.Background);
  });

  it('reflects a visible flip Interactive↔Background (fallback when pty_mode absent)', () => {
    const base = { status: ProcessStatus.RUNNING, workerStatus: WorkerStatus.THINKING };
    expect(classifyExecutionMode({ ...base, visible: true })).toBe(ExecutionMode.Interactive);
    expect(classifyExecutionMode({ ...base, visible: false })).toBe(ExecutionMode.Background);
  });

  // ── transport-keyed (pty_mode) rows — the new contract ──
  it.each([ProcessStatus.RUNNING, ProcessStatus.STARTING])(
    'live %s + pty_mode=true → Interactive',
    (s) => {
      expect(classifyExecutionMode({ status: s, pty_mode: true })).toBe(ExecutionMode.Interactive);
    },
  );

  it.each([ProcessStatus.RUNNING, ProcessStatus.STARTING])(
    'live %s + pty_mode=false → Background',
    (s) => {
      expect(classifyExecutionMode({ status: s, pty_mode: false })).toBe(ExecutionMode.Background);
    },
  );

  it('hidden live PTY (visible=false, pty_mode=true) → Interactive, NOT Background', () => {
    // Transport wins over tab visibility — the row the old visible-keyed
    // classifier bucketed as a headless Background worker.
    expect(
      classifyExecutionMode({ status: ProcessStatus.RUNNING, visible: false, pty_mode: true }),
    ).toBe(ExecutionMode.Interactive);
  });

  it('hidden live PTY with dead PID → Error (rule 2 keys on pty_mode)', () => {
    expect(
      classifyExecutionMode({
        status: ProcessStatus.RUNNING,
        visible: false,
        pty_mode: true,
        pidAlive: false,
      }),
    ).toBe(ExecutionMode.Error);
  });

  it('shown headless worker (visible=true, pty_mode=false) → Background', () => {
    expect(
      classifyExecutionMode({ status: ProcessStatus.RUNNING, visible: true, pty_mode: false }),
    ).toBe(ExecutionMode.Background);
  });
});

// ─── supportedExecutionModes gating ──────────────────────────────────────────

describe('supportedExecutionModes', () => {
  it('standard hides error + external', () => {
    expect(supportedExecutionModes(false)).toEqual([
      ExecutionMode.Interactive,
      ExecutionMode.Background,
    ]);
  });

  it('advanced/dev adds error + external', () => {
    expect(supportedExecutionModes(true)).toEqual([
      ExecutionMode.Interactive,
      ExecutionMode.Background,
      ExecutionMode.Error,
      ExecutionMode.External,
    ]);
  });
});

// ─── isReadyForInput truth table ─────────────────────────────────────────────

describe('isReadyForInput', () => {
  const readyWorkers: WorkerStatus[] = [
    WorkerStatus.IDLE,
    WorkerStatus.COMPLETE,
    WorkerStatus.INTERRUPTED,
  ];
  const notReadyWorkers: WorkerStatus[] = [
    WorkerStatus.INITIALIZING,
    WorkerStatus.WORKING,
    WorkerStatus.THINKING,
    WorkerStatus.TOOL_CALL,
    WorkerStatus.TOOL_RUNNING,
    WorkerStatus.ERROR,
    WorkerStatus.INACTIVE,
    WorkerStatus.API_ERROR,
    WorkerStatus.API_TIMEOUT,
    WorkerStatus.UNKNOWN,
  ];

  it.each(readyWorkers)('returns true when status=RUNNING and workerStatus=%s', (w) => {
    expect(isReadyForInput({ status: ProcessStatus.RUNNING, workerStatus: w })).toBe(true);
  });

  it.each(notReadyWorkers)('returns false when status=RUNNING and workerStatus=%s', (w) => {
    expect(isReadyForInput({ status: ProcessStatus.RUNNING, workerStatus: w })).toBe(false);
  });

  it.each([
    ProcessStatus.NEW,
    ProcessStatus.STARTING,
    ProcessStatus.STOPPING,
    ProcessStatus.STOPPED,
    ProcessStatus.FAILED,
  ])('returns false for non-RUNNING lifecycle status %s regardless of worker status', (s) => {
    for (const w of [...readyWorkers, ...notReadyWorkers]) {
      expect(isReadyForInput({ status: s, workerStatus: w })).toBe(false);
    }
  });

  it('treats missing workerStatus + no session as ready (never prompted)', () => {
    expect(isReadyForInput({ status: ProcessStatus.RUNNING, session_id: null })).toBe(true);
    expect(isReadyForInput({ status: ProcessStatus.RUNNING })).toBe(true);
  });

  it('treats missing workerStatus + session set as busy (just launched)', () => {
    expect(isReadyForInput({ status: ProcessStatus.RUNNING, session_id: 'sess-1' })).toBe(false);
  });

  it('reads worker_status (snake_case) on wire payloads', () => {
    expect(
      isReadyForInput({
        status: ProcessStatus.RUNNING,
        worker_status: WorkerStatus.IDLE,
      }),
    ).toBe(true);
  });
});

// ─── getDisplayStatus ────────────────────────────────────────────────────────

describe('getDisplayStatus', () => {
  it('returns workerStatus when the process is in a running lifecycle state', () => {
    expect(
      getDisplayStatus({ status: ProcessStatus.RUNNING, workerStatus: WorkerStatus.THINKING }),
    ).toBe(WorkerStatus.THINKING);
    expect(
      getDisplayStatus({ status: ProcessStatus.STARTING, workerStatus: WorkerStatus.IDLE }),
    ).toBe(WorkerStatus.IDLE);
  });

  it('falls back to ProcessStatus when workerStatus is missing', () => {
    expect(getDisplayStatus({ status: ProcessStatus.RUNNING })).toBe(ProcessStatus.RUNNING);
  });

  it('returns ProcessStatus for non-running lifecycle states', () => {
    for (const s of [ProcessStatus.NEW, ProcessStatus.STOPPED, ProcessStatus.FAILED]) {
      expect(getDisplayStatus({ status: s, workerStatus: WorkerStatus.THINKING })).toBe(s);
    }
  });

  it('returns undefined for processes with no status at all', () => {
    expect(getDisplayStatus({})).toBeUndefined();
  });
});

// ─── hasWorkerStarted ────────────────────────────────────────────────────────

describe('hasWorkerStarted', () => {
  it('is false only for INITIALIZING', () => {
    expect(hasWorkerStarted(WorkerStatus.INITIALIZING)).toBe(false);
    const started: WorkerStatus[] = [
      WorkerStatus.IDLE,
      WorkerStatus.WORKING,
      WorkerStatus.THINKING,
      WorkerStatus.TOOL_CALL,
      WorkerStatus.TOOL_RUNNING,
      WorkerStatus.COMPLETE,
      WorkerStatus.ERROR,
      WorkerStatus.INTERRUPTED,
      WorkerStatus.INACTIVE,
      WorkerStatus.API_ERROR,
      WorkerStatus.API_TIMEOUT,
      WorkerStatus.UNKNOWN,
    ];
    for (const s of started) expect(hasWorkerStarted(s)).toBe(true);
  });
});
