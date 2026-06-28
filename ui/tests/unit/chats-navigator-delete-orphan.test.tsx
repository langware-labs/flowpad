import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AgenticProcess } from '@sdk';
import { ChatsNavigator } from '@src/components/chats-navigator/ChatsNavigator';
import { useWorkerHistory, type WorkerHistoryEntry } from '@src/hooks/useWorkerHistory';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression: clicking "Delete chat" on a chat whose on-disk session has no
 * materialized AgenticProcess entity (agentic_process_id == null) must STILL
 * delete it — resolving the durable worker_id through the heal (`getByWorkerId`)
 * and removing the agentic process (which tombstones the transcript, so the
 * worker-history entry disappears too).
 *
 * The bug (proven this session, live): `ChatsNavigator.requestDelete` keys off
 * the lazily-materialized `agentic_process_id`, which is null for any chat never
 * opened through this instance. Its first line `if (!entry.agentic_process_id)
 * return;` fires, so the confirm dialog never opens, no delete request goes out,
 * and the chat is effectively undeletable — the exact identity inversion the
 * OPEN path was already fixed for (see chats-navigator-resume-orphan.test.tsx).
 */

const navMocks = vi.hoisted(() => ({
  openDockPointer: vi.fn(),
  openShellProcess: vi.fn(),
}));

// NavigatorPanel is presentational chrome (header/filter/tree) — not the unit
// under test. Render only its body so the real ChatsList + ChatHistoryRow +
// requestDelete/confirmDelete + ConfirmDialog stay in the path.
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

const WORKER_ID = 'a1d3f9c2-7b40-4e51-9f88-2c6e0a4d1b33';

/** An orphan-but-deletable Claude session: real transcript on disk (has a name
 *  + messages) but NO AgenticProcess entity, so agentic_process_id is null. */
function orphanEntry(): WorkerHistoryEntry {
  return {
    worker_type: 'claude',
    worker_id: WORKER_ID,
    project_id: '72fac107-c8df-5ab0-8cd1-54edb97bbe71',
    project_name: 'syncmd',
    project_cwd: '/Users/alice/Documents/dev/syncmd',
    last_active_time: '2026-06-26T20:31:52.385000Z',
    name: 'Delete me chat',
    last_prompt: 'hi',
    git_branch: 'main',
    message_count: 2,
    agentic_process_id: null,
  };
}

describe('ChatsNavigator — delete orphan (no agentic_process_id) session', () => {
  const deleteSpy = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    // Orphan: not in the entity cache (never materialized in this instance)...
    vi.spyOn(AgenticProcess, 'getByIdFromCache').mockReturnValue(null as unknown as AgenticProcess);
    // ...but resolvable from its on-disk session by the durable worker_id.
    vi.spyOn(AgenticProcess, 'getByWorkerId').mockResolvedValue({
      delete: deleteSpy,
    } as unknown as AgenticProcess);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('opens the confirm dialog and deletes via the worker-id heal instead of no-opping', async () => {
    mockUseWorkerHistory.mockReturnValue({ entries: [orphanEntry()], isLoading: false, refetch: vi.fn() });

    render(<ChatsNavigator />);

    // Click the per-row trash button (revealed on hover; present in the DOM).
    fireEvent.click(screen.getByLabelText('Delete chat'));

    // The proven root cause: requestDelete early-returns on the null
    // agentic_process_id, so this dialog never opens today.
    const confirm = await screen.findByText('Delete chat?');
    expect(confirm).toBeTruthy();

    // Confirming must resolve the durable worker_id through the heal and delete
    // the agentic process (tombstoning the transcript → worker entry gone too).
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(AgenticProcess.getByWorkerId).toHaveBeenCalledWith(WORKER_ID, 'claude'));
    await waitFor(() => expect(deleteSpy).toHaveBeenCalledTimes(1));
  });
});
