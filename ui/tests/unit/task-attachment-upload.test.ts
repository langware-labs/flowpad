/**
 * `uploadFilesToTask` — the one way bytes become a task attachment: into the
 * task's own `attachments/` folder (so a shared task's .flowmsg carries them),
 * returned as `{vfs, label}` entries for `task.artifacts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fsManager, TypeId } from '@sdk';
import { uploadFilesToTask } from '@src/components/assets/editor/task/task-attachment-upload';

const TASK = new TypeId('task', '11111111-1111-4111-8111-111111111111');
const file = (name: string) => new File([new Uint8Array([1])], name, { type: 'image/png' });

afterEach(() => vi.restoreAllMocks());

describe('uploadFilesToTask', () => {
  it('uploads into attachments/ and returns the new entries', async () => {
    const upload = vi.spyOn(fsManager, 'uploadFile').mockResolvedValue({} as never);
    const a = file('a.png');

    expect(await uploadFilesToTask(TASK, [a])).toEqual([{ vfs: 'attachments/a.png', label: 'a.png' }]);
    expect(upload).toHaveBeenCalledWith(TASK, '/attachments', a);
  });

  it('skips a file already attached, and a duplicate in the same batch', async () => {
    const upload = vi.spyOn(fsManager, 'uploadFile').mockResolvedValue({} as never);
    const existing = [{ vfs: 'attachments/a.png', label: 'a.png' }];

    const added = await uploadFilesToTask(TASK, [file('a.png'), file('b.png'), file('b.png')], existing);

    expect(added).toEqual([{ vfs: 'attachments/b.png', label: 'b.png' }]);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('reports a failed upload and leaves it out', async () => {
    vi.spyOn(fsManager, 'uploadFile').mockImplementation((_t, _p, f: File) =>
      f.name === 'bad.png' ? Promise.reject(new Error('disk full')) : Promise.resolve({} as never),
    );
    const onError = vi.fn();

    const added = await uploadFilesToTask(TASK, [file('bad.png'), file('ok.png')], [], onError);

    expect(added.map((e) => e.vfs)).toEqual(['attachments/ok.png']);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ name: 'bad.png' }), expect.any(Error));
  });
});
