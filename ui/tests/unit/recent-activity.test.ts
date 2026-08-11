import { describe, expect, it, vi } from 'vitest';
import type { SearchResult } from '@src/hooks/use-record-search';
import type { WorkerHistoryEntry } from '@src/hooks/useWorkerHistory';
import { mergeRecentActivity } from '@src/pages/flow-page/use-recent-activity';
import {
  getDockPointerForResult,
  isResultNavigable,
  navigateToResult,
} from '@src/navigation/record-type-nav';

const UUID = '11111111-1111-4111-8111-111111111111';

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

  it.each(['graph_workflow', 'graph_context', 'spec'])(
    'has a dedicated pointer for %s',
    (recordType) => {
      const result = entity(recordType, 300);
      expect(isResultNavigable(result)).toBe(true);
      expect(getDockPointerForResult(result)).not.toBeNull();
    },
  );
});
