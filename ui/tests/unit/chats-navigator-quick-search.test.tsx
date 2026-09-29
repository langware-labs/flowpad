import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AgenticProcess } from '@sdk';
import { ChatsNavigator } from '@src/components/chats-navigator/ChatsNavigator';
import { useWorkerHistory, type WorkerHistoryEntry } from '@src/hooks/useWorkerHistory';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The magnifier on the Chats "New" row turns the whole row into a session
 * quick-search line: the list below narrows to matching sessions, flat (no
 * Today/Yesterday headers), latest on top; Esc closes and restores the list.
 */

// Render the filter bar + body; the panel chrome is not under test.
vi.mock('@src/components/navigator-panel/NavigatorPanel', () => ({
  NavigatorPanel: ({ descriptor }: { descriptor: { header: { filterBar: React.ReactNode }; customBody: React.ReactNode } }) => (
    <>
      {descriptor.header.filterBar}
      {descriptor.customBody}
    </>
  ),
}));

vi.mock('@src/hooks/useWorkerHistory', async (orig) => ({
  ...(await orig<typeof import('@src/hooks/useWorkerHistory')>()),
  useWorkerHistory: vi.fn(),
}));

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: {}, currentDock: { scopeFilter: { mode: 'all' } } }),
}));
vi.mock('@src/hooks/useProject', () => ({ useProject: () => ({ project: null }) }));
vi.mock('@src/hooks/useContext', () => ({ useContext: () => ({ activeTerminalTargetTypeId: null }) }));

const HOUR = 60 * 60 * 1000;

function entry(id: string, name: string, agoMs: number): WorkerHistoryEntry {
  return {
    worker_type: 'claude',
    worker_id: id,
    project_id: null,
    project_name: null,
    project_cwd: null,
    last_active_time: new Date(Date.now() - agoMs).toISOString(),
    name,
    last_prompt: null,
    git_branch: null,
    message_count: 2,
    agentic_process_id: null,
  } as WorkerHistoryEntry;
}

const titles = () => screen.getAllByTestId('chat-history-row').map((r) => r.textContent ?? '');

describe('ChatsNavigator — session quick search', () => {
  beforeEach(() => {
    vi.spyOn(AgenticProcess, 'getByIdFromCache').mockReturnValue(null as unknown as AgenticProcess);
    vi.mocked(useWorkerHistory).mockReturnValue({
      entries: [
        entry('11111111-1111-4111-8111-111111111111', 'deploy old', 72 * HOUR),
        entry('22222222-2222-4222-8222-222222222222', 'unrelated', 1 * HOUR),
        entry('33333333-3333-4333-8333-333333333333', 'deploy new', 2 * HOUR),
      ],
      fetchedCount: 3,
      isLoading: false,
      refetch: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('filters to matching sessions, latest first, without bucket headers; Esc restores', () => {
    render(<ChatsNavigator />);
    expect(screen.getByText('Today')).toBeTruthy();
    expect(screen.getAllByTestId('chat-history-row')).toHaveLength(3);

    fireEvent.click(screen.getByTestId('chats-quick-search'));
    const input = screen.getByTestId('chats-quick-search-input');
    expect(document.activeElement).toBe(input);
    // The launcher row is replaced by the search line.
    expect(screen.queryByTestId('chats-new-claude')).toBeNull();

    fireEvent.change(input, { target: { value: 'deploy' } });
    const rows = titles();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('deploy new');
    expect(rows[1]).toContain('deploy old');
    expect(screen.queryByText('Today')).toBeNull();

    fireEvent.change(input, { target: { value: 'nothing-matches' } });
    expect(screen.getByText('No matching sessions')).toBeTruthy();

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByTestId('chats-quick-search-input')).toBeNull();
    expect(screen.getAllByTestId('chat-history-row')).toHaveLength(3);
  });
});
