/**
 * FLOWPAD-2030 — what `useChatHistory` still owns now the filter moved into
 * `useWorkerHistory`: passing `fetchedCount` through untouched (paging compares
 * it against the page limit) and grouping the rows it is handed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useWorkerHistory, type WorkerHistoryEntry } from '@src/hooks/useWorkerHistory';
import { ALL_SCOPE_FILTER } from '@src/lib/scope-filter';

vi.mock('@src/hooks/useWorkerHistory', async (orig) => ({
  ...(await orig<typeof import('@src/hooks/useWorkerHistory')>()),
  useWorkerHistory: vi.fn(),
}));

vi.mock('@sdk/react/hooks', () => ({
  useEntitiesQuery: () => ({ data: [] }),
}));

import { useChatHistory } from '@src/components/chats-navigator/useChatHistory';

const mockUseWorkerHistory = vi.mocked(useWorkerHistory);

function entry(overrides: Partial<WorkerHistoryEntry>): WorkerHistoryEntry {
  return {
    worker_type: 'claude',
    worker_id: 'w',
    project_id: null,
    project_name: null,
    project_cwd: null,
    last_active_time: new Date().toISOString(),
    name: 'A chat',
    last_prompt: null,
    git_branch: null,
    message_count: 3,
    agentic_process_id: null,
    ...overrides,
  };
}

function render(entries: WorkerHistoryEntry[], fetchedCount: number) {
  mockUseWorkerHistory.mockReturnValue({ entries, fetchedCount, isLoading: false, refetch: vi.fn() });
  const { result } = renderHook(() => useChatHistory({ scope: ALL_SCOPE_FILTER, search: '' }, 50, 1));
  return result.current;
}

describe('useChatHistory — wiring to its source hook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes fetchedCount through untouched, even when scope hides rows', () => {
    // `total` is what is displayed; `fetchedCount` is what the backend returned.
    const { total, fetchedCount } = render([entry({ worker_id: 'a' }), entry({ worker_id: 'b' })], 7);

    expect(total).toBe(2);
    expect(fetchedCount).toBe(7);
  });

  it('still groups the rows it is given into recency buckets', () => {
    const { buckets } = render([entry({ worker_id: 'a' })], 1);

    expect(buckets).toHaveLength(1);
    expect(buckets[0].entries.map((e) => e.worker_id)).toEqual(['a']);
  });
});
