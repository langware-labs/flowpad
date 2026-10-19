import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { HistoryModal } from '@src/components/terminal/HistoryModal';
import { useWorkerHistory, type WorkerHistoryEntry } from '@src/hooks/useWorkerHistory';
import { useProject } from '@src/hooks/useProject';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@src/hooks/useWorkerHistory', async (orig) => ({
  ...(await orig<typeof import('@src/hooks/useWorkerHistory')>()),
  useWorkerHistory: vi.fn(),
}));

vi.mock('@src/hooks/useProject', () => ({ useProject: vi.fn(() => ({ project: null })) }));

const mockUseWorkerHistory = vi.mocked(useWorkerHistory);
const mockUseProject = vi.mocked(useProject);

function entry(overrides: Partial<WorkerHistoryEntry>): WorkerHistoryEntry {
  return {
    worker_type: 'claude',
    worker_id: '11111111-1111-4111-8111-111111111111',
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

describe('HistoryModal', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders worker-specific icons for mixed recent sessions', () => {
    mockUseWorkerHistory.mockReturnValue({
      entries: [
        entry({
          worker_type: 'codex',
          worker_id: '22222222-2222-4222-8222-222222222222',
          name: 'Codex task',
        }),
        entry({
          worker_type: 'claude',
          worker_id: '33333333-3333-4333-8333-333333333333',
          name: 'Claude task',
        }),
      ],
      fetchedCount: 2,
      isLoading: false,
      refetch: vi.fn(),
    });

    render(<HistoryModal open onOpenChange={vi.fn()} onSelect={vi.fn()} />);

    expect(screen.getByText('Codex task')).toBeTruthy();
    expect(screen.getByText('Claude task')).toBeTruthy();
    // Which vendor a row wears — the drift this component's docstring records,
    // where an opencode row used to show Claude's mark.
    expect(document.querySelector('[data-provider="codex"]')).not.toBeNull();
    expect(document.querySelector('[data-provider="claude"]')).not.toBeNull();
  });

  it('filters visible sessions inline by name or last prompt', () => {
    mockUseWorkerHistory.mockReturnValue({
      entries: [
        entry({
          worker_id: '22222222-2222-4222-8222-222222222222',
          name: 'Refactor auth',
        }),
        entry({
          worker_id: '33333333-3333-4333-8333-333333333333',
          name: null,
          last_prompt: 'investigate flaky test',
        }),
        entry({
          worker_id: '44444444-4444-4444-8444-444444444444',
          name: 'Docs cleanup',
        }),
      ],
      fetchedCount: 3,
      isLoading: false,
      refetch: vi.fn(),
    });

    render(<HistoryModal open onOpenChange={vi.fn()} onSelect={vi.fn()} />);

    // Toggle filter open and type a query that matches only the middle entry.
    fireEvent.click(screen.getByTestId('history-search-toggle'));
    fireEvent.change(screen.getByTestId('history-search-input'), {
      target: { value: 'flaky' },
    });

    expect(screen.getByText(/investigate flaky test/i)).toBeTruthy();
    expect(screen.queryByText('Refactor auth')).toBeNull();
    expect(screen.queryByText('Docs cleanup')).toBeNull();
  });

  /**
   * The active project scope goes to the BACKEND. This modal used to fetch
   * unscoped and keep only rows whose `project_id` equalled the active project's
   * — but the unscoped walk labels a session with the project derived from its
   * cwd, while the scoped walk labels it with the id its AgenticProcess carries.
   * With two Project rows over one checkout those disagree, every row was
   * dropped, and the modal read "No recent sessions" beside a Chats panel
   * listing the very same sessions.
   */
  describe('project scope', () => {
    const ACTIVE_PROJECT_ID = '6b4fb358-0eb0-4417-bf71-2ec7e519d7c5';

    beforeEach(() => {
      mockUseProject.mockReturnValue({ project: { id: ACTIVE_PROJECT_ID } } as ReturnType<typeof useProject>);
      mockUseWorkerHistory.mockReturnValue({
        entries: [
          entry({
            worker_id: '55555555-5555-4555-8555-555555555555',
            name: 'Vibemode active display stripe investigation',
            // The id the cwd-derived path stamps — NOT the active project's.
            project_id: '4cac3e87-803e-41a0-a5d5-f7d230c48da2',
          }),
        ],
        fetchedCount: 1,
        isLoading: false,
        refetch: vi.fn(),
      });
    });

    it('asks the backend for the active project instead of filtering client-side', () => {
      render(<HistoryModal open onOpenChange={vi.fn()} onSelect={vi.fn()} />);

      expect(mockUseWorkerHistory).toHaveBeenCalledWith(
        expect.any(Number),
        expect.objectContaining({ projectIds: [ACTIVE_PROJECT_ID] }),
      );
    });

    it('renders a scoped row whose project_id differs from the active project id', () => {
      render(<HistoryModal open onOpenChange={vi.fn()} onSelect={vi.fn()} />);

      expect(screen.getByText('Vibemode active display stripe investigation')).toBeTruthy();
      expect(screen.queryByText(/No recent sessions/i)).toBeNull();
    });
  });
});
