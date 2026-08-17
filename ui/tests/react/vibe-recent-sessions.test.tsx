import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SearchResult } from '@src/hooks/use-record-search';
import type { WorkerHistoryEntry } from '@src/hooks/useWorkerHistory';
import type { RecentActivityItem } from '@src/pages/flow-page/use-recent-activity';

const getByWorkerId = vi.fn();
const getByIdFromCache = vi.fn(() => null);
const openDockPointer = vi.fn();
const navigateToResult = vi.fn();
const useRecentActivitySpy = vi.fn();
let activityItems: RecentActivityItem[] = [];
let hasMore = false;
let projectId: string | null = 'proj-1';

vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sdk')>();
  return {
    ...actual,
    AgenticProcess: {
      ...actual.AgenticProcess,
      getByWorkerId: (...args: unknown[]) => getByWorkerId(...args),
      getByIdFromCache: (...args: unknown[]) => getByIdFromCache(...args),
    },
  };
});

vi.mock('@sdk/react/hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sdk/react/hooks')>();
  return { ...actual, useProject: () => ({ project: projectId ? { id: projectId } : null }) };
});

vi.mock('@src/pages/flow-page/use-recent-activity', () => ({
  useRecentActivity: (...args: unknown[]) => {
    useRecentActivitySpy(...args);
    return { items: activityItems, isLoading: false, error: null, hasMore };
  },
}));

vi.mock('@src/navigation/record-type-nav', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@src/navigation/record-type-nav')>();
  return { ...actual, navigateToResult: (...args: unknown[]) => navigateToResult(...args) };
});

vi.mock('@src/navigation/useDockNavigation', () => ({
  useCurrentDock: () => null,
  useDockNavigation: () => ({ navigation: { openDockPointer } }),
}));

vi.mock('@src/notifications', () => ({ notify: { error: vi.fn() } }));

import { VibeRecentSessions } from '@src/pages/flow-page/vibe-recent-sessions';

function sessionEntry(n: number): WorkerHistoryEntry {
  return {
    worker_type: 'claude',
    worker_id: `w${n}`,
    project_id: 'proj-1',
    project_name: 'Project',
    project_cwd: '/tmp/project',
    last_active_time: new Date(1_700_000_000_000 + n).toISOString(),
    name: `Session ${n}`,
    last_prompt: null,
    git_branch: null,
    message_count: null,
    agentic_process_id: null,
  };
}

function markdownResult(n: number): SearchResult {
  return {
    record_id: `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`,
    record_type: 'markdown',
    name: `Document ${n}`,
    text: '',
    status: 'indexed',
    scope: 'project',
    created_at: '',
    modified_at: '',
    last_edited_at: 1_800_000_000_000 + n,
    asset_ref: `/tmp/document-${n}.md`,
  };
}

function sessionItem(n: number, timestampMs = 1_700_000_000_000 + n): RecentActivityItem {
  return { kind: 'session', key: `session:${n}`, timestampMs, entry: sessionEntry(n) };
}

function entityItem(n: number, timestampMs = 1_800_000_000_000 + n): RecentActivityItem {
  return { kind: 'entity', key: `entity:${n}`, timestampMs, result: markdownResult(n) };
}

describe('VibeRecentSessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getByIdFromCache.mockReturnValue(null);
    activityItems = [];
    hasMore = false;
    projectId = 'proj-1';
  });

  it('requests project-scoped activity and renders edited assets with sessions', () => {
    activityItems = [entityItem(1), sessionItem(1)];
    render(<VibeRecentSessions />);

    expect(useRecentActivitySpy).toHaveBeenCalledWith(
      { mode: 'project', activeProjectId: 'proj-1' },
      expect.any(Number),
    );
    expect(screen.getByRole('heading', { name: 'Recent activity' })).toBeInTheDocument();
    expect(screen.getByTestId('vibe-recent-entity')).toHaveTextContent('Document 1');
    expect(screen.getByTestId('vibe-recent-session')).toHaveTextContent('Session 1');
  });

  it('renders nothing when there is no current project or activity', () => {
    const { rerender } = render(<VibeRecentSessions />);
    expect(screen.queryByTestId('vibe-recent-sessions')).toBeNull();

    projectId = null;
    activityItems = [sessionItem(1)];
    rerender(<VibeRecentSessions />);
    expect(screen.queryByTestId('vibe-recent-sessions')).toBeNull();
  });

  it('caps the compact mixed feed at five rows', () => {
    activityItems = Array.from({ length: 7 }, (_, i) => (
      i % 2 ? sessionItem(i + 1) : entityItem(i + 1)
    ));
    render(<VibeRecentSessions />);

    expect([
      ...screen.queryAllByTestId('vibe-recent-entity'),
      ...screen.queryAllByTestId('vibe-recent-session'),
    ]).toHaveLength(5);
  });

  it('routes an edited entity through the central URL-first dispatcher', async () => {
    const user = userEvent.setup();
    const item = entityItem(1);
    activityItems = [item];
    render(<VibeRecentSessions />);

    await user.click(screen.getByTestId('vibe-recent-entity'));

    expect(navigateToResult).toHaveBeenCalledWith(item.result, expect.any(Object));
  });

  it('keeps worker sessions resumable in the vibe skin', async () => {
    const user = userEvent.setup();
    const terminalDockPointer = { viewType: 'shell' };
    getByWorkerId.mockResolvedValue({ id: 'p1', terminalDockPointer });
    activityItems = [sessionItem(1)];
    render(<VibeRecentSessions />);

    await user.click(screen.getByTestId('vibe-recent-session'));

    expect(getByWorkerId).toHaveBeenCalledWith('w1', 'claude');
    await waitFor(() => expect(openDockPointer).toHaveBeenCalledWith(
      terminalDockPointer,
      { viewMode: 'vibe' },
    ));
  });

  it('opens a full mixed activity dialog from More', async () => {
    const user = userEvent.setup();
    activityItems = [entityItem(1), sessionItem(1)];
    render(<VibeRecentSessions />);

    await user.click(screen.getByTestId('vibe-recent-show-more'));

    const dialog = screen.getByTestId('recent-activity-dialog');
    expect(within(dialog).getByTestId('vibe-recent-entity')).toHaveTextContent('Document 1');
    expect(within(dialog).getByTestId('vibe-recent-session')).toHaveTextContent('Session 1');
    expect(useRecentActivitySpy).toHaveBeenLastCalledWith(
      { mode: 'project', activeProjectId: 'proj-1' },
      expect.any(Number),
    );
  });

  it('loads the next activity page inside the full dialog', async () => {
    const user = userEvent.setup();
    activityItems = [entityItem(1)];
    hasMore = true;
    render(<VibeRecentSessions />);

    await user.click(screen.getByTestId('vibe-recent-show-more'));
    await user.click(screen.getByTestId('recent-activity-load-more'));

    expect(useRecentActivitySpy).toHaveBeenLastCalledWith(
      { mode: 'project', activeProjectId: 'proj-1' },
      100,
    );
  });

  it('can expand the full dialog across all projects', async () => {
    const user = userEvent.setup();
    activityItems = [entityItem(1)];
    render(<VibeRecentSessions />);

    await user.click(screen.getByTestId('vibe-recent-show-more'));
    await user.click(screen.getByTestId('recent-activity-all-projects'));

    expect(useRecentActivitySpy).toHaveBeenLastCalledWith(
      { mode: 'all' },
      50,
    );
  });
});
