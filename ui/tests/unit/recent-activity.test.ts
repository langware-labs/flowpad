import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TypeId } from '@sdk';
import type { SearchResult } from '@src/hooks/use-record-search';
import type { WorkerHistoryEntry } from '@src/hooks/useWorkerHistory';
import { projectScope } from '@src/lib/scope-filter';
import {
  mergeRecentActivity,
  recentEditSearchResult,
} from '@src/pages/flow-page/use-recent-activity';
import {
  getDockPointerForResult,
  isResultNavigable,
  navigateToResult,
} from '@src/navigation/record-type-nav';

const UUID = '11111111-1111-4111-8111-111111111111';
const PROJECT_UUID = '22222222-2222-4222-8222-222222222222';

function entity(
  recordType: string,
  lastEditedAt: number,
  overrides: Partial<SearchResult> = {},
): SearchResult {
  return {
    record_id: UUID,
    record_type: recordType,
    name: 'Edited document',
    text: '',
    status: 'indexed',
    scope: 'project',
    created_at: '',
    modified_at: '',
    last_edited_at: lastEditedAt,
    asset_ref: '',
    ...overrides,
  };
}

function session(overrides: Partial<WorkerHistoryEntry> = {}): WorkerHistoryEntry {
  return {
    worker_type: 'claude',
    worker_id: 'worker-1',
    project_id: 'project-1',
    project_name: 'Project',
    project_cwd: '/tmp/project',
    last_active_time: new Date(100).toISOString(),
    name: 'Session',
    last_prompt: null,
    git_branch: null,
    message_count: null,
    agentic_process_id: null,
    ...overrides,
  };
}

describe('recent activity projection', () => {
  it('globally sorts navigable edited assets with worker sessions', () => {
    const rows = mergeRecentActivity(
      [
        entity('markdown', 300),
        entity('comment', 500), // no session_id: deliberately unreachable
      ],
      [session()],
    );

    expect(rows.map((row) => row.kind)).toEqual(['entity', 'session']);
    expect(rows[0]).toMatchObject({ kind: 'entity', timestampMs: 300 });
  });

  it('folds a materialized process edit into its session instead of duplicating it', () => {
    const rows = mergeRecentActivity(
      [entity('agentic_process', 400)],
      [session({ agentic_process_id: UUID })],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'session', timestampMs: 400 });
  });

  it('shows a scoped local edit immediately and deduplicates its durable row', () => {
    const local = recentEditSearchResult(
      { target: new TypeId('markdown', UUID), markedAt: 500 },
      { displayName: 'summary', project_id: PROJECT_UUID, system: false, scope: 'project' },
      projectScope(PROJECT_UUID),
    );
    expect(local).toMatchObject({ name: 'summary', last_edited_at: 500 });
    expect(recentEditSearchResult(
      { target: new TypeId('markdown', UUID), markedAt: 500 },
      { displayName: 'summary', project_id: PROJECT_UUID, system: false },
      projectScope('33333333-3333-4333-8333-333333333333'),
    )).toBeNull();

    const rows = mergeRecentActivity([entity('markdown', 300)], [], [local!]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'entity', timestampMs: 500 });
    expect(rows[0].kind === 'entity' && rows[0].result.name).toBe('summary');
  });
});

describe('recent activity navigation coverage', () => {
  it('uses the central asset-editor registry fallback for newly editable types', async () => {
    const result = entity('whiteboard', 300);
    const pointer = getDockPointerForResult(result);
    const openDock = vi.fn();

    expect(isResultNavigable(result)).toBe(true);
    expect(pointer?.toUrl()).toContain('/editor/whiteboard/typeid/whiteboard-');

    await navigateToResult(result, { openDock } as never);
    expect(openDock).toHaveBeenCalledWith(pointer);
  });

  it('routes launchable agents to the agent profile editor', () => {
    expect(getDockPointerForResult(entity('agent', 300))?.toUrl())
      .toContain('/editor/agent/typeid/agent-');
  });

  it.each(['graph_workflow', 'graph_context', 'trigger', 'conversation', 'spec'])(
    'has a dedicated pointer for %s',
    (recordType) => {
      const result = entity(recordType, 300);
      expect(isResultNavigable(result)).toBe(true);
      expect(getDockPointerForResult(result)).not.toBeNull();
    },
  );
});

/**
 * FLOWPAD-2030 — paging must survive the empty-chat filter: a full page that
 * contained hidden rows would read as short and end pagination early, so
 * `hasMore` compares `fetchedCount` (pre-filter), not the displayed count.
 */
describe('useRecentActivity — paging past hidden chats', () => {
  const LIMIT = 5;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  async function renderRecentActivity(opts: { fetchedCount: number; visible: number }) {
    const buckets = [
      {
        label: 'Today',
        entries: Array.from({ length: opts.visible }, (_, i) =>
          session({ worker_id: `w-${i}`, message_count: 2 }),
        ),
      },
    ];

    vi.doMock('@src/components/chats-navigator/useChatHistory', () => ({
      useChatHistory: () => ({
        buckets,
        total: opts.visible,
        fetchedCount: opts.fetchedCount,
        isLoading: false,
        refetch: vi.fn(),
      }),
    }));
    vi.doMock('@src/hooks/use-record-search', () => ({
      useRecordSearch: () => ({ results: [], total: 0, isLoading: false, error: null }),
    }));

    const { useRecentActivity } = await import('@src/pages/flow-page/use-recent-activity');
    const { renderHook } = await import('@testing-library/react');
    return renderHook(() => useRecentActivity(projectScope(PROJECT_UUID), LIMIT)).result.current;
  }

  it('keeps hasMore when a full page was fetched but empty chats were hidden', async () => {
    const { hasMore } = await renderRecentActivity({ fetchedCount: LIMIT, visible: 2 });

    expect(hasMore).toBe(true);
  });

  it('reports no more pages when the backend returned a short page', async () => {
    const { hasMore } = await renderRecentActivity({ fetchedCount: 2, visible: 2 });

    expect(hasMore).toBe(false);
  });
});
