import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AgenticProcess } from '@sdk';
import { ChatsNavigator } from '@src/components/chats-navigator/ChatsNavigator';
import { useWorkerHistory, type WorkerHistoryEntry } from '@src/hooks/useWorkerHistory';
import { notify } from '@src/notifications';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression: clicking a chat whose on-disk session has no materialized
 * AgenticProcess entity (agentic_process_id == null) must STILL open it by
 * resolving the durable worker_id through the heal (`getByWorkerId`) — not
 * reject it as "This chat has no resumable session.".
 *
 * The bug was an identity inversion: the navigator keyed openability off the
 * lazily-materialized AgenticProcess entity instead of the worker_id that every
 * worker-history row carries. See ChatsNavigator.handleSelect.
 */

const navMocks = vi.hoisted(() => ({
  openDockPointer: vi.fn(),
  openShellProcess: vi.fn(),
}));

// NavigatorPanel is presentational chrome (header/filter/tree) — not the unit
// under test. Render only its body so the real ChatsList + ChatHistoryRow +
// handleSelect + useResumeInTerminal stay in the path.
vi.mock('@src/components/navigator-panel/NavigatorPanel', () => ({
  NavigatorPanel: ({ descriptor }: { descriptor: { customBody: React.ReactNode } }) => descriptor.customBody,
}));

vi.mock('@src/hooks/useWorkerHistory', async (orig) => ({
  ...(await orig<typeof import('@src/hooks/useWorkerHistory')>()),
  useWorkerHistory: vi.fn(),
}));

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: navMocks, currentDock: { scopeFilter: { mode: 'all' } } }),
}));

vi.mock('@src/hooks/useProject', () => ({ useProject: () => ({ project: null }) }));

vi.mock('@src/hooks/useContext', () => ({ useContext: () => ({ activeTerminalTargetTypeId: null }) }));

vi.mock('@src/notifications', () => ({
  notify: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const mockUseWorkerHistory = vi.mocked(useWorkerHistory);

/** An orphan-but-resumable Claude session: real transcript on disk (has a
 *  name + messages) but NO AgenticProcess entity, so agentic_process_id is null. */
function orphanEntry(): WorkerHistoryEntry {
  return {
    worker_type: 'claude',
    worker_id: '62ec5cf8-de6e-4786-ad0f-0e0c54f17a96',
    project_id: '72fac107-c8df-5ab0-8cd1-54edb97bbe71',
    project_name: 'sapora-streams',
    project_cwd: '/Users/alice/Flowpad workspace/sapora-streams',
    last_active_time: '2026-06-26T20:31:52.385000Z',
    name: 'Debug missing session history',
    last_prompt: 'open the shell dock and click history',
    git_branch: 'main',
    message_count: 127,
    agentic_process_id: null,
  };
}

describe('ChatsNavigator — resume orphan (no agentic_process_id) session', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(AgenticProcess, 'getByIdFromCache').mockReturnValue(null as unknown as AgenticProcess);
    vi.spyOn(AgenticProcess, 'getByWorkerId').mockResolvedValue({
      terminalDockPointer: { sentinel: 'terminal-dock' },
    } as unknown as AgenticProcess);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('opens via the worker-id heal instead of erroring "no resumable session"', async () => {
    mockUseWorkerHistory.mockReturnValue({ entries: [orphanEntry()], fetchedCount: 1, isLoading: false, refetch: vi.fn() });

    render(<ChatsNavigator />);

    fireEvent.click(screen.getByText('Debug missing session history'));

    // Resolves the durable worker_id (with the worker_type hint) through the heal...
    await vi.waitFor(() =>
      expect(AgenticProcess.getByWorkerId).toHaveBeenCalledWith(
        '62ec5cf8-de6e-4786-ad0f-0e0c54f17a96',
        'claude',
      ),
    );
    // ...and opens the LIVE terminal (not the read-only transcript)...
    await vi.waitFor(() =>
      expect(navMocks.openDockPointer).toHaveBeenCalledWith({ sentinel: 'terminal-dock' }, undefined),
    );
    // ...never the dead "no resumable session" gate.
    expect(notify.error).not.toHaveBeenCalled();
    expect(navMocks.openShellProcess).not.toHaveBeenCalled();
  });
});
