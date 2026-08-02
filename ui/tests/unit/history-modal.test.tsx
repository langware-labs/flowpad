import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { HistoryModal } from '@src/components/terminal/HistoryModal';
import { useWorkerHistory, type WorkerHistoryEntry } from '@src/hooks/useWorkerHistory';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@src/hooks/useWorkerHistory', async (orig) => ({
  ...(await orig<typeof import('@src/hooks/useWorkerHistory')>()),
  useWorkerHistory: vi.fn(),
}));

const mockUseWorkerHistory = vi.mocked(useWorkerHistory);

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
      isLoading: false,
      refetch: vi.fn(),
    });

    render(<HistoryModal open onOpenChange={vi.fn()} onSelect={vi.fn()} />);

    expect(screen.getByText('Codex task')).toBeTruthy();
    expect(screen.getByText('Claude task')).toBeTruthy();
    expect(document.querySelector('svg[aria-label="Codex"]')).not.toBeNull();
    expect(document.querySelector('svg[aria-label="Claude"]')).not.toBeNull();
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
});
