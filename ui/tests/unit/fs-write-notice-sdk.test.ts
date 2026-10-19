/**
 * fsManager.onFileWritten: every editor save (writeFile / updateDocument) tells
 * git-state views to re-ask — a git-tracked asset save is auto-committed
 * server-side with no event of its own. A failed write announces nothing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dataManager, fsManager, TypeId } from '@sdk';

const node = new TypeId('compute_node', '@local');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fsManager.onFileWritten', () => {
  it('fires after a successful write or document save, and stops after unsubscribe', async () => {
    vi.spyOn(dataManager, 'callAction').mockResolvedValue({});
    const listener = vi.fn();
    const off = fsManager.onFileWritten(listener);

    await fsManager.writeFile(node, '/a.md', 'x');
    await fsManager.updateDocument(node, '/agent.md', { expected_revision: 'r1', body: 'y' });
    expect(listener).toHaveBeenCalledTimes(2);

    off();
    await fsManager.writeFile(node, '/a.md', 'z');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('a failed save announces nothing', async () => {
    vi.spyOn(dataManager, 'callAction').mockRejectedValue(new Error('conflict'));
    const listener = vi.fn();
    const off = fsManager.onFileWritten(listener);

    await expect(fsManager.updateDocument(node, '/agent.md', { expected_revision: 'r1' })).rejects.toThrow();
    expect(listener).not.toHaveBeenCalled();
    off();
  });
});
