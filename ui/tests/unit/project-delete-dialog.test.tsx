/**
 * Deleting a project from the UI: the dialog asks, and the folder on disk is
 * the user's own work, so removing it is opt-in. Drives the real dialog and the
 * real SDK call; only the HTTP transport (`apiClient.post`) is observed.
 */
import { act, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Project } from '@sdk';
import apiClient from '@sdk/client';
import { DeleteAssetModal } from '@src/components/assets/delete-asset-modal';
import { confirmProjectDelete } from '@src/components/assets/confirm-project-delete';
import { unitTestSetup } from '../utils/test-utils';

const ID = '55555555-5555-4555-8555-555555555555';
const PATH = '/Users/someone/work/acme';

beforeEach(unitTestSetup);
afterEach(() => vi.restoreAllMocks());

function openDialog(onDeleted = vi.fn()) {
  const post = vi.spyOn(apiClient, 'post').mockResolvedValue({ project_id: ID, deleted_children: 0 });
  const project = new Project({ id: ID, name: 'acme', fs_storage_mount_path: PATH });
  render(<DeleteAssetModal />);
  act(() => confirmProjectDelete(project, onDeleted));
  return { post, onDeleted };
}

const folderBox = () => screen.getByRole('checkbox', { name: /delete the project folder from my computer/i });
const chatsBox = () => screen.getByRole('checkbox', { name: /delete chats/i });
const sentBody = (post: ReturnType<typeof vi.spyOn>) => post.mock.calls.at(-1)?.[1];

it('keeps the folder unless the user ticks the box', async () => {
  const user = userEvent.setup();
  const { post, onDeleted } = openDialog();

  expect(folderBox()).not.toBeChecked();
  expect(chatsBox()).toBeChecked();
  await user.click(screen.getByTestId('delete-asset-modal-confirm'));

  expect(sentBody(post)).toEqual({ delete_chats: true, delete_folder: false });
  expect(onDeleted).toHaveBeenCalledOnce();
});

it('deletes the folder when the box is ticked', async () => {
  const user = userEvent.setup();
  const { post } = openDialog();

  await user.click(folderBox());
  await user.click(screen.getByTestId('delete-asset-modal-confirm'));

  expect(sentBody(post)).toEqual({ delete_chats: true, delete_folder: true });
});

it('sends each option on its own', async () => {
  const user = userEvent.setup();
  const { post } = openDialog();

  await user.click(chatsBox());
  await user.click(screen.getByTestId('delete-asset-modal-confirm'));

  expect(sentBody(post)).toEqual({ delete_chats: false, delete_folder: false });
});

it('names the folder in the option, and does not promise to delete it up front', () => {
  openDialog();

  expect(screen.getByText(PATH, { exact: false })).toBeInTheDocument();
  expect(screen.getByTestId('delete-asset-modal')).not.toHaveTextContent(/and the project folder on disk/i);
});

it('warns about local files and renames the button only while the folder box is ticked', async () => {
  const user = userEvent.setup();
  openDialog();
  const confirm = screen.getByTestId('delete-asset-modal-confirm');

  expect(confirm).toHaveTextContent(/^Remove Project$/);
  expect(screen.queryByText(/uncommitted Git changes/i)).not.toBeInTheDocument();

  await user.click(folderBox());
  expect(confirm).toHaveTextContent('Remove Project & Delete Files');
  expect(screen.getByRole('alert')).toHaveTextContent(/uncommitted Git changes/i);

  await user.click(folderBox());
  expect(confirm).toHaveTextContent(/^Remove Project$/);
  expect(screen.queryByText(/uncommitted Git changes/i)).not.toBeInTheDocument();
});

it('the SDK call is safe by default: no folder unless asked', async () => {
  const post = vi.spyOn(apiClient, 'post').mockResolvedValue({ project_id: ID, deleted_children: 0 });

  await new Project({ id: ID }).deleteWithChildren();

  expect(post.mock.calls[0][1]).toEqual({ delete_chats: true, delete_folder: false });
});

it('refuses the old positional form instead of deleting the chats it meant to keep', async () => {
  const post = vi.spyOn(apiClient, 'post');

  // @ts-expect-error -- an untyped caller still on `deleteWithChildren(false)`
  await expect(new Project({ id: ID }).deleteWithChildren(false)).rejects.toThrow(TypeError);

  expect(post).not.toHaveBeenCalled();
});
