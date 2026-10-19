/**
 * FLOWPAD-2030 — which processes the "Past chats" dropdown offers. Entity-backed,
 * and the only source that sees a "New" click never opened or prompted: it has no
 * `session_id`, so it never reaches worker-history at all.
 */
import { describe, expect, it } from 'vitest';
import type { WorkerHistoryEntry } from '@src/hooks/useWorkerHistory';
import { selectHistoryProcesses } from '@src/components/entity-execution-panel/history-processes';

function proc(id: string, session_id: string | null) {
  return { id, session_id };
}

function entry(overrides: Partial<WorkerHistoryEntry>): WorkerHistoryEntry {
  return {
    worker_type: 'claude',
    worker_id: 'sid',
    project_id: null,
    project_name: null,
    project_cwd: null,
    last_active_time: '2026-05-06T12:00:00Z',
    name: null,
    last_prompt: null,
    git_branch: null,
    message_count: null,
    agentic_process_id: null,
    ...overrides,
  };
}

const NO_JOIN = new Map<string, WorkerHistoryEntry>();

const idsOf = (rows: { id: string }[]) => rows.map((r) => r.id);

describe('selectHistoryProcesses', () => {
  it('drops a process that never got a session id', () => {
    // Minted at start()/prompt(), never at createProcess: absence proves no turn ran.
    const rows = selectHistoryProcesses([proc('used', 'sid-1'), proc('fresh', null)], NO_JOIN, null);

    expect(idsOf(rows)).toEqual(['used']);
  });

  it('keeps the active process even when it has no session id at all', () => {
    // Clicking "New" lands the user in a chat that is empty by definition.
    const rows = selectHistoryProcesses([proc('fresh', null), proc('other', null)], NO_JOIN, 'fresh');

    expect(idsOf(rows)).toEqual(['fresh']);
  });

  it('keeps a process that is outside the worker-history join window', () => {
    // The join covers ~30 rows: absence is "unknown", not "empty".
    const rows = selectHistoryProcesses([proc('old', 'sid-2')], NO_JOIN, null);

    expect(idsOf(rows)).toEqual(['old']);
  });

  it('drops a joined process whose entry shows no evidence of a turn', () => {
    const join = new Map([['ghost', entry({ agentic_process_id: 'ghost' })]]);
    const rows = selectHistoryProcesses([proc('ghost', 'sid-3')], join, null);

    expect(rows).toHaveLength(0);
  });

  it('keeps a joined process whose entry has counted messages', () => {
    const join = new Map([['real', entry({ agentic_process_id: 'real', message_count: 7 })]]);
    const rows = selectHistoryProcesses([proc('real', 'sid-4')], join, null);

    expect(idsOf(rows)).toEqual(['real']);
  });

  it('keeps a joined process whose count is unknown but which has a title', () => {
    const join = new Map([['titled', entry({ agentic_process_id: 'titled', name: 'Refactor auth' })]]);
    const rows = selectHistoryProcesses([proc('titled', 'sid-5')], join, null);

    expect(idsOf(rows)).toEqual(['titled']);
  });

  it('preserves the incoming order of the rows it keeps', () => {
    const rows = selectHistoryProcesses(
      [proc('a', 'sid-a'), proc('empty', null), proc('b', 'sid-b')],
      NO_JOIN,
      null,
    );

    expect(idsOf(rows)).toEqual(['a', 'b']);
  });

  it('returns nothing when every process is empty and none is active', () => {
    // Drives the trigger's `disabled` state and the "No past chats" label.
    expect(selectHistoryProcesses([proc('x', null), proc('y', null)], NO_JOIN, null)).toHaveLength(0);
  });
});
