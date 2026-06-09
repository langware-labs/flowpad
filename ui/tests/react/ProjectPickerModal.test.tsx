import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProjectPickerModal } from '@src/components/assets/ProjectPickerModal';
import { useProjectList } from '@src/hooks/use-claude-projects';

vi.mock('@src/hooks/use-claude-projects', () => ({
  useProjectList: vi.fn(),
  getProjectDisplayName: (project: { name?: string; cwd?: string }) => project.name ?? project.cwd ?? '',
}));

const mockUseProjectList = vi.mocked(useProjectList);

beforeEach(() => {
  mockUseProjectList.mockReturnValue({
    projects: [
      {
        id: 'project-alpha-id',
        record_project_id: 'project-alpha-record-id',
        encoded_name: '-tmp-project-alpha',
        name: 'Project Alpha',
        cwd: '/tmp/project-alpha',
        modified_at: '2024-01-02T00:00:00Z',
        session_count: 2,
      },
      {
        id: 'project-beta-id',
        record_project_id: 'project-beta-record-id',
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
    expect(onConfirm).toHaveBeenCalledWith(['project-alpha-id']);
  });
});
