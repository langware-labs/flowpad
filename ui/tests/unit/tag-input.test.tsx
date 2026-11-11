/**
 * The shared tag field, and the entity control built on it.
 *
 * What is pinned: typed text is converted before it becomes a tag, text that
 * converts to nothing adds nothing, a suggestion can be picked, and on an
 * entity each change is the `tags` action whose answer becomes the chips.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

const apiGet = vi.hoisted(() => vi.fn());
vi.mock('@sdk/client', () => ({ default: { get: apiGet } }));

import { ActionInfo, Task, dataManager } from '@sdk';
import { TagInput } from '@src/components/tags/TagInput';
import { EntityTags } from '@src/components/tags/EntityTags';

// cmdk keeps the highlighted row in view; jsdom has no layout and so no scrollIntoView.
Element.prototype.scrollIntoView = vi.fn();

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mount(tags: string[] = []) {
  apiGet.mockResolvedValue({ names: ['meeting-notes', 'project.alpha', 'draft'] });
  const onAdd = vi.fn();
  const onRemove = vi.fn();
  render(<TagInput tags={tags} onAdd={onAdd} onRemove={onRemove} />);
  return { onAdd, onRemove, field: screen.getByPlaceholderText('Add tag…') };
}

describe('TagInput', () => {
  it('converts what is typed, on Enter and on a comma, and adds nothing for text with no tag in it', async () => {
    const user = userEvent.setup();
    const { onAdd, field } = mount();

    await user.type(field, 'Meeting Notes{Enter}');
    await user.type(field, 'Project/Beta,');
    await user.type(field, '!!!{Enter}');
    await user.type(field, '{Enter}');

    expect(onAdd.mock.calls).toEqual([['meeting-notes'], ['project.beta']]);
    expect((field as HTMLInputElement).value).toBe('');
  });

  it('does not add a tag that is already there, and removes one by its button', async () => {
    const user = userEvent.setup();
    const { onAdd, onRemove, field } = mount(['draft']);

    await user.type(field, 'Draft{Enter}');
    await user.click(screen.getByRole('button', { name: 'Remove tag draft' }));

    expect(onAdd).not.toHaveBeenCalled();
    expect(onRemove).toHaveBeenCalledWith('draft');
  });

  it('suggests the names in use, fetched when the field is first focused, and adds the one picked', async () => {
    const user = userEvent.setup();
    const { onAdd, field } = mount(['draft']);
    expect(apiGet).not.toHaveBeenCalled();

    await user.type(field, 'alp');
    await user.click(await screen.findByTestId('tag-suggestion-project.alpha'));

    expect(apiGet).toHaveBeenCalledTimes(1);
    expect(apiGet).toHaveBeenCalledWith('/api/v1/tags/names');
    // A tag the entity already has is not offered again.
    expect(screen.queryByTestId('tag-suggestion-draft')).toBeNull();
    expect(onAdd.mock.calls).toEqual([['project.alpha']]);
  });
});

describe('EntityTags', () => {
  it('adds and removes through the tag action, and shows the list the backend answers with', async () => {
    const user = userEvent.setup();
    apiGet.mockResolvedValue({ names: [] });
    const task = new Task({ id: '0b6f3c1e-5a52-4f0e-9d0b-6f1f6f0f3a11', title: 'T', tags: ['draft'] });
    vi.spyOn(dataManager, 'getByTypeIdFromCache').mockReturnValue(task as never);
    const calls: ActionInfo[] = [];
    vi.spyOn(dataManager, 'callAction').mockImplementation(async (info) => {
      calls.push(info as ActionInfo);
      return { tags: (info as ActionInfo).method === 'POST' ? ['draft', 'meeting-notes'] : ['meeting-notes'] } as never;
    });

    render(<EntityTags typeId={task.typeId} />);
    await user.type(await screen.findByPlaceholderText('Add tag…'), 'Meeting Notes{Enter}');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove tag meeting-notes' })).toBeTruthy());

    await user.click(screen.getByRole('button', { name: 'Remove tag draft' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove tag draft' })).toBeNull());

    expect(calls.map((c) => [c.name, c.targetEntity?.type, c.targetEntity?.id, c.method, c.subpath])).toEqual([
      ['tags', 'task', task.id, 'POST', 'meeting-notes'],
      ['tags', 'task', task.id, 'DELETE', 'draft'],
    ]);
  });
});
