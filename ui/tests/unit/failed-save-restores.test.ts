/** A save the server refuses must not leave the entity showing the unsaved edit. */
import { dataManager, Task } from '@sdk';
import apiClient from '@sdk/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TASK_ID = '10000000-0000-4000-8000-000000000002';
const CREATED_DATE = '2026-08-02T06:07:15.800334Z';

describe('a failed save', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await dataManager.clearCache();
  });

  afterEach(() => vi.restoreAllMocks());

  it("puts back the server's copy and still rejects", async () => {
    const task = new Task({ id: TASK_ID, type: Task.type, title: 'Saved title', created_date: CREATED_DATE } as never);
    expect(task.saved).toBe(true);
    vi.spyOn(apiClient, 'put').mockRejectedValue(new Error('Bad Gateway'));
    const get = vi.spyOn(apiClient, 'get').mockResolvedValue({ ...task.toJSON(), title: 'Saved title' } as never);

    task.title = 'Unsaved edit';
    await expect(task.save()).rejects.toThrow('Bad Gateway');

    expect(get).toHaveBeenCalledTimes(1);
    expect(task.title).toBe('Saved title');
    expect(task.dirty).toBe(false);
  });
});
