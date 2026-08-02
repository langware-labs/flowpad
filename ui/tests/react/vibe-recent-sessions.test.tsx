import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WorkerHistoryEntry } from '@src/hooks/useWorkerHistory';

const getByWorkerId = vi.fn();
const getByIdFromCache = vi.fn(() => null);
const openDockPointer = vi.fn();
const useChatHistorySpy = vi.fn();
let buckets: Array<{ label: string; entries: WorkerHistoryEntry[] }> = [];
let isLoading = false;
let projectId: string | null = 'proj-1';

// Partial: `@sdk` is a barrel other importers (locale-context, i18n-init) pull
// real exports from — replacing it wholesale breaks them.
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

vi.mock('@src/components/chats-navigator/useChatHistory', () => ({
  useChatHistory: (...args: unknown[]) => {
    useChatHistorySpy(...args);
    return { buckets, total: 0, isLoading, refetch: vi.fn() };
  },
}));

vi.mock('@src/navigation/useDockNavigation', () => ({
  useCurrentDock: () => null,
  useDockNavigation: () => ({ navigation: { openDockPointer } }),
}));

vi.mock('@src/components/terminal/HistoryModal', () => ({
  HistoryModal: ({ open }: { open: boolean }) => (open ? <div data-testid="history-modal-open" /> : null),
}));

vi.mock('@src/notifications', () => ({ notify: { error: vi.fn() } }));

import { VibeRecentSessions } from '@src/pages/flow-page/vibe-recent-sessions';

function entry(n: number): WorkerHistoryEntry {
  return {
    worker_type: 'claude',
    worker_id: `w${n}`,
    project_id: null,
    project_name: null,
    project_cwd: null,
    last_active_time: new Date().toISOString(),
    name: `Session ${n}`,
    last_prompt: null,
    git_branch: null,
    message_count: null,
    agentic_process_id: null,
  } as WorkerHistoryEntry;
}

describe('VibeRecentSessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getByIdFromCache.mockReturnValue(null);
    buckets = [];
    isLoading = false;
    projectId = 'proj-1';
  });

  it('scopes the list to the current project', () => {
    buckets = [{ label: 'Today', entries: [entry(1)] }];
    render(<VibeRecentSessions />);

    expect(useChatHistorySpy).toHaveBeenCalledWith(
      { scope: { mode: 'project', activeProjectId: 'proj-1' }, search: '' },
      expect.any(Number),
    );
  });

  it('renders nothing when there is no current project', () => {
    projectId = null;
    // Entries the projectless scope might still surface must not leak through.
    buckets = [{ label: 'Today', entries: [entry(1)] }];
    render(<VibeRecentSessions />);

    expect(screen.queryByTestId('vibe-recent-sessions')).toBeNull();
  });

  it('renders nothing when there are no sessions', () => {
    render(<VibeRecentSessions />);

    expect(screen.queryByTestId('vibe-recent-sessions')).toBeNull();
    expect(screen.queryByTestId('vibe-recent-show-more')).toBeNull();
  });

  it('renders nothing (no skeleton) while loading with no entries', () => {
    isLoading = true;
    render(<VibeRecentSessions />);

    expect(screen.queryByTestId('vibe-recent-sessions')).toBeNull();
  });

  it('caps at 5 rows and preserves recency order across buckets', () => {
    buckets = [
      { label: 'Today', entries: [entry(1), entry(2), entry(3)] },
      { label: 'Yesterday', entries: [entry(4), entry(5), entry(6), entry(7)] },
    ];
    render(<VibeRecentSessions />);

    const rows = screen.getAllByTestId('vibe-recent-session');
    expect(rows).toHaveLength(5);
    expect(rows[0]).toHaveTextContent('Session 1');
    expect(rows[4]).toHaveTextContent('Session 5');
  });

  it('opens a clicked session in the vibe skin', async () => {
    const user = userEvent.setup();
    const terminalDockPointer = { viewType: 'shell' };
    getByWorkerId.mockResolvedValue({ id: 'p1', terminalDockPointer });
    buckets = [{ label: 'Today', entries: [entry(1)] }];
    render(<VibeRecentSessions />);

    await user.click(screen.getByTestId('vibe-recent-session'));

    expect(getByWorkerId).toHaveBeenCalledWith('w1', 'claude');
    await waitFor(() => expect(openDockPointer).toHaveBeenCalledWith(terminalDockPointer, { viewMode: 'vibe' }));
  });

  it('opens the history modal from "Show more"', async () => {
    const user = userEvent.setup();
    buckets = [{ label: 'Today', entries: [entry(1)] }];
    render(<VibeRecentSessions />);

    expect(screen.queryByTestId('history-modal-open')).toBeNull();
    await user.click(screen.getByTestId('vibe-recent-show-more'));

    expect(screen.getByTestId('history-modal-open')).toBeInTheDocument();
  });
});
