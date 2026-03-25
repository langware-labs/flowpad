import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ProjectPickerModal } from '@src/components/assets/ProjectPickerModal';

// Mock apiClient.get to return fake projects
vi.mock('@sdk/client', () => ({
  default: {
    get: vi.fn().mockResolvedValue({
      results: [
        { record_id: 'p1', name: 'Project Alpha' },
        { record_id: 'p2', name: 'Project Beta' },
      ],
      total: 2,
    }),
  },
}));

describe('ProjectPickerModal', () => {
  it('renders project list and confirms selection', async () => {
    const onConfirm = vi.fn();
    render(
      <ProjectPickerModal open={true} onOpenChange={() => {}} selectedIds={[]} onConfirm={onConfirm} />
    );
    await waitFor(() => expect(screen.getByText('Project Alpha')).toBeDefined());
    fireEvent.click(screen.getByText('Project Alpha'));
    fireEvent.click(screen.getByText('Confirm'));
    expect(onConfirm).toHaveBeenCalledWith(['p1']);
  });
});
