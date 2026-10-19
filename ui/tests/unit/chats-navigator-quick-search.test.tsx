import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AgenticProcess } from '@sdk';
import { ChatsNavigator } from '@src/components/chats-navigator/ChatsNavigator';
import { useWorkerHistory, type WorkerHistoryEntry } from '@src/hooks/useWorkerHistory';
import apiClient from '@sdk/client';
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

// The session-content search (backend FTS) — answered per test.
vi.mock('@sdk/client', () => ({ default: { get: vi.fn() } }));

vi.mock('@src/hooks/useWorkerHistory', async (orig) => ({
  ...(await orig<typeof import('@src/hooks/useWorkerHistory')>()),
  useWorkerHistory: vi.fn(),
}));

// One stable dock object, like the URL-derived one in the app — a fresh object
// per render would re-key the scope and re-fire the content search forever.
const DOCK: { navigation: object; currentDock: { scopeFilter: Record<string, unknown> } } = {
  navigation: {},
  currentDock: { scopeFilter: { mode: 'all' } },
};
vi.mock('@src/navigation/useDockNavigation', () => ({ useDockNavigation: () => DOCK }));
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
    // Rows are bucketed by local day; "2 hours ago" is yesterday shortly after midnight.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 5, 15, 12, 0, 0));
    vi.mocked(apiClient.get).mockResolvedValue({ results: [] });
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
    vi.useRealTimers();
    DOCK.currentDock.scopeFilter = { mode: 'all' };
    cleanup();
    vi.restoreAllMocks();
  });

  it('filters to matching sessions, latest first, without bucket headers; Esc restores', async () => {
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
    // Detailed rows: a meta line under each.
    expect(screen.getAllByTestId('chat-history-row-meta')).toHaveLength(2);

    fireEvent.change(input, { target: { value: 'nothing-matches' } });
    // The content search is still out → no premature "no match".
    expect(screen.getByText('Searching inside sessions…')).toBeTruthy();
    expect(await screen.findByText('No matching sessions')).toBeTruthy();

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByTestId('chats-quick-search-input')).toBeNull();
    expect(screen.getAllByTestId('chat-history-row')).toHaveLength(3);
  });

  it('also lists sessions whose CONTENT matches, as a phrase query, loaded or not', async () => {
    // "CLI analysis": its title and last prompt miss "one cli"; only an earlier
    // prompt has it. The second hit is older than the loaded history page.
    vi.mocked(apiClient.get).mockImplementation(async (path: string) => {
      const params = new URLSearchParams(path.split('?')[1]);
      if (params.get('record_type') !== 'claude_session') return { results: [] };
      expect(params.get('q')).toBe('"one cli"');
      return {
        results: [
          { record_id: '22222222-2222-4222-8222-222222222222', record_type: 'claude_session', name: 'unrelated', modified_at: new Date().toISOString() },
          { record_id: '44444444-4444-4444-8444-444444444444', record_type: 'claude_session', name: 'CLI analysis', fts_title: 'CLI analysis', snippet: '…read about <mark>one cli</mark> and analyze\nhow it works…', modified_at: new Date(Date.now() - 400 * HOUR).toISOString() },
        ],
      };
    });

    render(<ChatsNavigator />);
    fireEvent.click(screen.getByTestId('chats-quick-search'));
    fireEvent.change(screen.getByTestId('chats-quick-search-input'), { target: { value: 'one cli' } });

    await waitFor(() => expect(screen.getAllByTestId('chat-history-row')).toHaveLength(2));
    const rows = titles();
    expect(rows[0]).toContain('unrelated'); // latest first
    expect(rows[1]).toContain('CLI analysis');
    // Search rows carry more than the one-liner: where it matched, highlighted.
    const match = screen.getAllByTestId('chat-history-row-match')[0];
    expect(match.textContent).toBe('…read about one cli and analyze how it works…');
    expect(match.querySelector('mark')?.textContent).toBe('one cli');
  });

  it('scopes content hits by their transcript folder, not the index scope', async () => {
    // Prod shape: session records are indexed user-scoped, so the search is
    // sent unscoped and the project scope is applied per row. "CLI analysis"
    // is older than the loaded page; its folder maps to the loaded project.
    const OSS = 'a7c37fc4-ca26-4bd1-9e28-1e99eaf7e16c';
    DOCK.currentDock.scopeFilter = { mode: 'project', activeProjectId: OSS };
    vi.mocked(useWorkerHistory).mockReturnValue({
      entries: [
        {
          ...entry('55555555-5555-4555-8555-555555555555', 'recent oss chat', HOUR),
          project_id: OSS,
          project_name: 'flowpad-oss',
          project_cwd: '/Users/me/dev/flowpad-oss',
        },
      ],
      fetchedCount: 1,
      isLoading: false,
      refetch: vi.fn(),
    });
    const sent: URLSearchParams[] = [];
    vi.mocked(apiClient.get).mockImplementation(async (path: string) => {
      const params = new URLSearchParams(path.split('?')[1]);
      sent.push(params);
      if (params.get('record_type') !== 'claude_session') return { results: [] };
      return {
        results: [
          { record_id: '44444444-4444-4444-8444-444444444444', record_type: 'claude_session', name: 'CLI analysis', scope: 'user', asset_ref: '/Users/me/.claude/projects/-Users-me-dev-flowpad-oss/44444444-4444-4444-8444-444444444444.jsonl', modified_at: new Date(Date.now() - 400 * HOUR).toISOString() },
          { record_id: '66666666-6666-4666-8666-666666666666', record_type: 'claude_session', name: 'other project', scope: 'user', asset_ref: '/Users/me/.claude/projects/-Users-me-dev-other/66666666-6666-4666-8666-666666666666.jsonl', modified_at: new Date().toISOString() },
        ],
      };
    });

    render(<ChatsNavigator />);
    fireEvent.click(screen.getByTestId('chats-quick-search'));
    fireEvent.change(screen.getByTestId('chats-quick-search-input'), { target: { value: 'one cli' } });

    await waitFor(() => expect(titles().some((r) => r.includes('CLI analysis'))).toBe(true));
    expect(titles()).toHaveLength(1);
    expect(sent.every((p) => !p.has('projects') && !p.has('user'))).toBe(true);
  });
});
