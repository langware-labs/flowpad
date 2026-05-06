import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { HistoryModal } from '@src/components/terminal/HistoryModal';
import { useWorkerHistory, type WorkerHistoryEntry } from '@src/hooks/useWorkerHistory';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@src/hooks/useWorkerHistory', () => ({
  useWorkerHistory: vi.fn(),
}));

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: vi.fn(),
}));

const mockUseWorkerHistory = vi.mocked(useWorkerHistory);
const mockUseDockNavigation = vi.mocked(useDockNavigation);

function entry(overrides: Partial<WorkerHistoryEntry>): WorkerHistoryEntry {
  return {
    worker_type: 'claude',
    worker_id: '11111111-1111-4111-8111-111111111111',
    project_id: null,
    project_name: null,
    project_cwd: null,
    last_active_time: '2026-05-06T12:00:00Z',
    name: null,
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
    mockUseDockNavigation.mockReturnValue({
      navigation: {
        openSearch: vi.fn(),
      },
    } as unknown as ReturnType<typeof useDockNavigation>);
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
      isLoading: false,
      refetch: vi.fn(),
    });

    render(<HistoryModal open onOpenChange={vi.fn()} onSelect={vi.fn()} />);

    expect(screen.getByText('Codex task')).toBeTruthy();
    expect(screen.getByText('Claude task')).toBeTruthy();
    expect(document.querySelector('svg[aria-label="Codex"]')).not.toBeNull();
    expect(document.querySelector('svg[aria-label="Claude"]')).not.toBeNull();
  });

  it('opens broad search from the search button', () => {
    const openSearch = vi.fn();
    const onOpenChange = vi.fn();
    mockUseDockNavigation.mockReturnValue({
      navigation: {
        openSearch,
      },
    } as unknown as ReturnType<typeof useDockNavigation>);
    mockUseWorkerHistory.mockReturnValue({
      entries: [],
      isLoading: false,
      refetch: vi.fn(),
    });

    render(<HistoryModal open onOpenChange={onOpenChange} onSelect={vi.fn()} />);

    fireEvent.click(screen.getByTitle('Search all sessions'));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(openSearch).toHaveBeenCalledWith();
  });
});
