import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProjectPickerModal } from '@src/components/assets/ProjectPickerModal';
import apiClient from '@sdk/client';

// Spy on apiClient.get to return fake projects without mocking the entire module
let getSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  getSpy = vi.spyOn(apiClient, 'get').mockResolvedValue({
    results: [
      { record_id: 'p1', name: 'Project Alpha' },
      { record_id: 'p2', name: 'Project Beta' },
    ],
    total: 2,
  } as any);
});

afterEach(() => {
  getSpy?.mockRestore();
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
    expect(onConfirm).toHaveBeenCalledWith(['p1']);
  });
});
