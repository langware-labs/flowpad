/**
 * TaskDescription — the task editor's editable description section.
 *
 * The field on the wire is `description` (a Lexical document); the section
 * edits it through the entity's `descriptionPlainText` accessor, so the patch
 * it hands to `save` must carry THAT key — assigning `description` directly
 * would write raw text where a Lexical doc is expected.
 *
 * It commits on blur, not per keystroke: every save re-renders `task.md` and
 * yields a new task ref, so per-character writes would churn the editor.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';

vi.mock('@sdk', async (importOriginal) => ({ ...(await importOriginal<typeof import('@sdk')>()), Task: class {} }));

import { TaskDescription } from '@src/components/assets/editor/task/TaskDescription';

function makeTask(plain = '') {
  return {
    typeId: { toString: () => 'task-abc' },
    descriptionPlainText: plain,
  } as never;
}

let save: ReturnType<typeof vi.fn>;

beforeEach(() => {
  save = vi.fn().mockResolvedValue(undefined);
});

afterEach(cleanup);

describe('TaskDescription', () => {
  it('seeds the box from the task and saves the edit on blur', () => {
    const { getByTestId } = render(<TaskDescription task={makeTask('old text')} save={save} />);
    const box = getByTestId('task-description') as HTMLTextAreaElement;
    expect(box.value).toBe('old text');

    fireEvent.change(box, { target: { value: 'new text' } });
    expect(save).not.toHaveBeenCalled(); // typing alone never writes

    fireEvent.blur(box);
    expect(save).toHaveBeenCalledWith({ descriptionPlainText: 'new text' });
  });

  it('does not save when the text is unchanged', () => {
    const { getByTestId } = render(<TaskDescription task={makeTask('same')} save={save} />);
    fireEvent.blur(getByTestId('task-description'));
    expect(save).not.toHaveBeenCalled();
  });

  it('saves an empty string when the description is cleared', () => {
    const { getByTestId } = render(<TaskDescription task={makeTask('had text')} save={save} />);
    const box = getByTestId('task-description');
    fireEvent.change(box, { target: { value: '   ' } });
    fireEvent.blur(box);
    expect(save).toHaveBeenCalledWith({ descriptionPlainText: '' });
  });

  it('renders read-only text with no editable box', () => {
    const { queryByTestId, getByText } = render(
      <TaskDescription task={makeTask('parent copy')} save={save} readOnly />,
    );
    expect(queryByTestId('task-description')).toBeNull();
    expect(getByText('parent copy')).toBeTruthy();
  });
});
