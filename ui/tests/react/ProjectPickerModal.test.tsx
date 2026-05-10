import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProjectPickerModal } from '@src/components/assets/ProjectPickerModal';
import { projectIdForPath } from '@src/components/assets/utils';
import { useClaudeProjectList } from '@src/hooks/use-claude-projects';

vi.mock('@src/hooks/use-claude-projects', () => ({
  useClaudeProjectList: vi.fn(),
  getProjectDisplayName: (project: { name?: string; cwd?: string }) => project.name ?? project.cwd ?? '',
}));

const mockUseClaudeProjectList = vi.mocked(useClaudeProjectList);

beforeEach(() => {
  mockUseClaudeProjectList.mockReturnValue({
    projects: [
      {
        encoded_name: '-tmp-project-alpha',
        name: 'Project Alpha',
        cwd: '/tmp/project-alpha',
        modified_at: '2024-01-02T00:00:00Z',
        session_count: 2,
      },
      {
        encoded_name: '-tmp-project-beta',
        name: 'Project Beta',
        cwd: '/tmp/project-beta',
        modified_at: '2024-01-01T00:00:00Z',
        session_count: 1,
      },
    ],
    totalCount: 2,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  } as any);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('ProjectPickerModal', () => {
  it('renders project list and confirms selection', async () => {
    const onConfirm = vi.fn();
    render(
      <ProjectPickerModal open={true} onOpenChange={() => {}} selectedIds={[]} onConfirm={onConfirm} />
    );
    await waitFor(() => expect(screen.getByText('Project Alpha')).toBeDefined());
    fireEvent.click(screen.getByText('Project Alpha'));
    fireEvent.click(screen.getByText('Confirm'));
    expect(onConfirm).toHaveBeenCalledWith([projectIdForPath('/tmp/project-alpha')]);
  });
});
