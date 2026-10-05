import { describe, expect, it } from 'vitest';
import { Task } from '@sdk/entities/task';

/** A task's description is stored as written (the task.md body); only a legacy Lexical JSON body is
 *  unwrapped on read, and nothing writes one any more. */
describe('Task.descriptionPlainText', () => {
  it('stores what is typed, as is', () => {
    const task = new Task({ title: 'x' });
    task.descriptionPlainText = 'line one\nline two';
    expect(task.description).toBe('line one\nline two');
    expect(task.descriptionPlainText).toBe('line one\nline two');
  });

  it('reads a plain or markdown body as is', () => {
    expect(new Task({ title: 'x', description: '# Ship it\n- now' }).descriptionPlainText).toBe('# Ship it\n- now');
  });

  it('still unwraps a legacy Lexical body', () => {
    const legacy = JSON.stringify({
      root: { children: [{ children: [{ text: 'old', type: 'text' }], type: 'paragraph' }], type: 'root' },
    });
    expect(new Task({ title: 'x', description: legacy }).descriptionPlainText).toBe('old');
  });
});
