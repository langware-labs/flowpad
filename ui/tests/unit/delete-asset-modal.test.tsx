import { act, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { DeleteAssetModal, showDeleteAssetModal } from '@src/components/assets/delete-asset-modal';

const OPTIONS = [
  { key: 'chats', label: 'Delete chats', defaultChecked: true },
  { key: 'folder', label: 'Delete the folder', defaultChecked: false },
];

it('opens every option at its default and submits what the user chose', async () => {
  const user = userEvent.setup();
  const submitted: Record<string, boolean>[] = [];
  render(<DeleteAssetModal />);
  const open = () => showDeleteAssetModal({
    name: 'temporary project',
    checkboxes: OPTIONS,
    onConfirm: async (checked) => { submitted.push(checked); },
  });

  act(open);
  expect(screen.getByRole('checkbox', { name: 'Delete chats' })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'Delete the folder' })).not.toBeChecked();
  await user.click(screen.getByRole('checkbox', { name: 'Delete chats' }));
  await user.click(screen.getByRole('checkbox', { name: 'Delete the folder' }));
  await user.click(screen.getByTestId('delete-asset-modal-confirm'));
  expect(submitted).toEqual([{ chats: false, folder: true }]);

  // A reopen starts from the defaults again, never from the last choice.
  act(open);
  expect(screen.getByRole('checkbox', { name: 'Delete chats' })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'Delete the folder' })).not.toBeChecked();
  await user.click(screen.getByTestId('delete-asset-modal-confirm'));
  expect(submitted).toEqual([{ chats: false, folder: true }, { chats: true, folder: false }]);
});

it('submits an empty choice when the request has no options', async () => {
  const user = userEvent.setup();
  const submitted: Record<string, boolean>[] = [];
  render(<DeleteAssetModal />);
  act(() => showDeleteAssetModal({ name: 'a.md', onConfirm: async (checked) => { submitted.push(checked); } }));

  expect(screen.queryByRole('checkbox')).toBeNull();
  await user.click(screen.getByTestId('delete-asset-modal-confirm'));
  expect(submitted).toEqual([{}]);
});
