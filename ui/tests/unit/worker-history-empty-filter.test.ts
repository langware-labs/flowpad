/**
 * FLOWPAD-2030 — the empty-chat filter, at the one place history is loaded, so
 * every surface inherits it. `message_count: null` means "unknown" as often as
 * "empty", and `fetchedCount` must stay pre-filter or paging ends early.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  data: null as unknown,
  activeTarget: null as { type: string; id: string } | null,
}));

vi.mock('@src/hooks/use-action', () => ({
  useAction: () => ({ data: mocks.data, isLoading: false, refetch: vi.fn() }),
}));

vi.mock('@src/hooks/useContext', () => ({
  // A real uuid: ActionInfo builds a TypeId, which rejects anything else.
  useContext: () => ({
    computeNode: { typeId: { id: '00000000-0000-4000-8000-0000000000c0' } },
    activeTerminalTargetTypeId: mocks.activeTarget,
  }),
}));

import { useWorkerHistory, isEmptyChatEntry, type WorkerHistoryEntry } from '@src/hooks/useWorkerHistory';

function entry(overrides: Partial<WorkerHistoryEntry>): WorkerHistoryEntry {
  return {
    worker_type: 'claude',
    worker_id: 'w',
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

function load(entries: WorkerHistoryEntry[], options?: Parameters<typeof useWorkerHistory>[1]) {
  mocks.data = entries;
  const { result } = renderHook(() => useWorkerHistory(30, options));
  return {
    ids: result.current.entries.map((e) => e.worker_id),
    fetchedCount: result.current.fetchedCount,
  };
}

describe('useWorkerHistory — empty chats', () => {
  beforeEach(() => {
    mocks.data = null;
    mocks.activeTarget = null;
    vi.clearAllMocks();
  });

  it('drops a chat with no count, no prompt and no name', () => {
    const { ids } = load([entry({ worker_id: 'real', name: 'Refactor auth' }), entry({ worker_id: 'empty' })]);

    expect(ids).toEqual(['real']);
  });

  it('keeps a chat whose count is unknown but which has a title', () => {
    // `null` means "the backend could not tell", not "zero" — a titled row ran.
    expect(load([entry({ worker_id: 'titled', name: 'Copilot session' })]).ids).toEqual(['titled']);
  });

  it('keeps a chat that has a last prompt', () => {
    expect(load([entry({ worker_id: 'prompted', last_prompt: 'why is this flaky' })]).ids).toEqual(['prompted']);
  });

  it('keeps a chat with counted messages', () => {
    expect(load([entry({ worker_id: 'busy', message_count: 4 })]).ids).toEqual(['busy']);
  });

  it('exempts the chat the user is currently in, even while it is still empty', () => {
    // Clicking "New" lands you in a chat that is empty by definition.
    const { ids } = load(
      [
        entry({ worker_id: 'current', agentic_process_id: 'proc-1' }),
        entry({ worker_id: 'other-empty', agentic_process_id: 'proc-2' }),
      ],
      { currentProcessId: 'proc-1' },
    );

    expect(ids).toEqual(['current']);
  });

  it('auto-detects the current chat from the active dock target', () => {
    // Every surface must inherit the exemption, not just the ones that pass it:
    // the terminal History modal and Spotlight never do (FLOWPAD-2030 follow-up).
    mocks.activeTarget = { type: 'agentic_process', id: 'proc-1' };
    const { ids } = load([
      entry({ worker_id: 'current', agentic_process_id: 'proc-1' }),
      entry({ worker_id: 'other-empty', agentic_process_id: 'proc-2' }),
    ]);

    expect(ids).toEqual(['current']);
  });

  it('ignores an active dock target that is not a process', () => {
    mocks.activeTarget = { type: 'markdown', id: 'proc-1' };
    const { ids } = load([entry({ worker_id: 'empty', agentic_process_id: 'proc-1' })]);

    expect(ids).toEqual([]);
  });

  it('does not exempt an empty chat that carries no process id', () => {
    // Guards a `null === undefined`-style bypass.
    const { ids } = load([entry({ worker_id: 'orphan', agentic_process_id: null })], {
      currentProcessId: 'proc-1',
    });

    expect(ids).toEqual([]);
  });

  it('returns the raw list when a consumer opts out', () => {
    // EntityExecutionPanel's metadata join needs every row to tell "empty" from
    // "outside this window".
    const { ids } = load([entry({ worker_id: 'real', message_count: 2 }), entry({ worker_id: 'empty' })], {
      includeEmpty: true,
    });

    expect(ids).toEqual(['real', 'empty']);
  });

  it('reports fetchedCount BEFORE the filter, so paging does not stop early', () => {
    const { ids, fetchedCount } = load([
      entry({ worker_id: 'real', message_count: 2 }),
      entry({ worker_id: 'empty-a' }),
      entry({ worker_id: 'empty-b' }),
    ]);

    expect(ids).toHaveLength(1);
    expect(fetchedCount).toBe(3);
  });

  it('survives a non-array payload', () => {
    mocks.data = undefined;
    const { result } = renderHook(() => useWorkerHistory(30));

    expect(result.current.entries).toEqual([]);
    expect(result.current.fetchedCount).toBe(0);
  });
});

describe('isEmptyChatEntry', () => {
  it('treats whitespace-only prompt and name as absent', () => {
    expect(isEmptyChatEntry({ message_count: null, last_prompt: '   ', name: ' ' })).toBe(true);
  });

  it('treats a real zero count as empty', () => {
    // opencode already reports a truthful 0; the other vendors coerce it to null.
    expect(isEmptyChatEntry({ message_count: 0, last_prompt: null, name: null })).toBe(true);
  });
});
