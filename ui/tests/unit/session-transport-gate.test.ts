import { isReadyForInput, ProcessStatus } from '@sdk';
import { describe, expect, it } from 'vitest';

// The chat⇄terminal switch may only be used while the agent is awaiting the
// user's input — a mid-turn switchMode is 409'd by the backend. The gate is the
// single readiness predicate: the transport segments are enabled ⇔ not busy AND
// (the process is RUNNING, fresh-headless, OR headless-idle — a CLI-transport
// session STOPPED between per-turn workers with a live session_id). "ready" and
// "busy" are disjoint by construction (!busy gates first), so enabling on ready
// can never hit the backend's busy 409. These tests pin the predicate and the
// header control's wiring.

describe('isReadyForInput — the "your turn" transport gate', () => {
  it('is true for a RUNNING, non-busy process', () => {
    expect(isReadyForInput({ status: ProcessStatus.RUNNING, busy: false })).toBe(true);
    expect(isReadyForInput({ status: ProcessStatus.RUNNING })).toBe(true); // busy defaults falsy
  });

  it('is true for a headless-idle session (CLI transport, STOPPED, live session_id)', () => {
    // RCA #12a: switching terminal→chat kills the per-turn PTY and lands the
    // process at STOPPED with its session_id preserved. The switch must stay
    // enabled so the user can switch back without first sending a message.
    expect(
      isReadyForInput({ status: ProcessStatus.STOPPED, busy: false, pty_mode: false, session_id: 'sess-abc' }),
    ).toBe(true);
  });

  it('is false when busy (turn in flight) and for non-live states with no live headless session', () => {
    // A RUNNING process with a turn in flight is busy, not ready.
    expect(isReadyForInput({ status: ProcessStatus.RUNNING, busy: true })).toBe(false);
    // A headless-idle session mid-turn is busy → not ready (no 409 hole).
    expect(
      isReadyForInput({ status: ProcessStatus.STOPPED, busy: true, pty_mode: false, session_id: 'sess-abc' }),
    ).toBe(false);
    // A stopped PTY (interactive transport) is not headless-idle → not ready.
    expect(
      isReadyForInput({ status: ProcessStatus.STOPPED, busy: false, pty_mode: true, session_id: 'sess-abc' }),
    ).toBe(false);
    for (const s of [
      ProcessStatus.STARTING,
      ProcessStatus.STOPPING,
      ProcessStatus.STOPPED, // no session_id → not headless-idle
      ProcessStatus.FAILED,
    ]) {
      expect(isReadyForInput({ status: s })).toBe(false);
    }
    expect(isReadyForInput({ status: ProcessStatus.NEW, pty_mode: true })).toBe(false);
    expect(isReadyForInput({})).toBe(false);
  });
});
