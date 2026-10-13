/**
 * The project picker keeps what the person typed and ticked while its parent re-renders. A caller passing
 * `selectedIds={[]}` hands a fresh array every render; keyed on that array, the reset effect wiped the search
 * and the ticks mid-pick, and Confirm added whatever row had slid under the cursor.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@src/hooks/use-claude-projects', () => ({
  useProjectList: () => ({
    projects: [
      { id: 'a', name: 'alpha', cwd: '/w/alpha' },
      { id: 'b', name: 'waha-service', cwd: '/w/waha-service' },
    ],
    isLoading: false,
  }),
  getProjectDisplayName: (p: { name: string }) => p.name,
}));

import { ProjectPickerModal } from '@src/components/assets/ProjectPickerModal';

afterEach(cleanup);

describe('ProjectPickerModal', () => {
  it('keeps the search across parent re-renders with a fresh empty selectedIds', async () => {
    const props = { open: true, onOpenChange: () => {}, onConfirm: () => {} };
    const { rerender } = render(<ProjectPickerModal {...props} selectedIds={[]} />);
    const box = screen.getByRole('textbox');
    await userEvent.type(box, 'waha');
    rerender(<ProjectPickerModal {...props} selectedIds={[]} />);
    expect(screen.getByRole('textbox')).toHaveValue('waha');
    expect(screen.queryByText('alpha')).not.toBeInTheDocument();
  });
});
