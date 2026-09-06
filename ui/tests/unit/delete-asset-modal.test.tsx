import { act, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { DeleteAssetModal, showDeleteAssetModal } from '@src/components/assets/delete-asset-modal';

it('defaults the deletion option to checked and submits the user selection', async () => {
  const user = userEvent.setup();
  const submitted: boolean[] = [];
  render(<DeleteAssetModal />);
  const open = () => showDeleteAssetModal({
    name: 'temporary project',
    checkbox: { label: 'Delete chats', defaultChecked: true },
    onConfirm: async (checked) => { submitted.push(checked); },
  });

  act(open);
  expect(screen.getByRole('checkbox', { name: 'Delete chats' })).toBeChecked();
  await user.click(screen.getByRole('checkbox', { name: 'Delete chats' }));
  await user.click(screen.getByTestId('delete-asset-modal-confirm'));
  expect(submitted).toEqual([false]);

  act(open);
  expect(screen.getByRole('checkbox', { name: 'Delete chats' })).toBeChecked();
  await user.click(screen.getByTestId('delete-asset-modal-confirm'));
  expect(submitted).toEqual([false, true]);
});
