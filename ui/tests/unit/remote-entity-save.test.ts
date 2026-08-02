/** A durable Hub mirror has no private creator but must update by id. */
import { dataManager, Task } from '@sdk';
import apiClient, { GRAPH_API_PREFIX } from '@sdk/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TASK_ID = '10000000-0000-4000-8000-000000000001';
const CREATED_DATE = '2026-08-02T06:07:15.800334Z';

describe('remote entity persistence', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await dataManager.clearCache();
  });

  afterEach(() => vi.restoreAllMocks());

  it('PUTs a creator-less Hub mirror with Hub-Reflect instead of POSTing a duplicate', async () => {
    const task = new Task({
      id: TASK_ID,
      type: Task.type,
      title: 'Assigned remotely',
      status: 'to_do',
      remote: true,
      created_date: CREATED_DATE,
    } as any);
    expect(task.created_by).toBeUndefined();
    expect(task.saved).toBe(true);

    const post = vi.spyOn(apiClient, 'post');
    const put = vi.spyOn(apiClient, 'put').mockResolvedValue({
      ...task.toJSON(),
      status: 'in_progress',
    } as never);

    task.status = 'in_progress';
    await task.save();

    expect(post).not.toHaveBeenCalled();
    expect(put).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith(
      `${GRAPH_API_PREFIX}/task/${TASK_ID}`,
      expect.objectContaining({ id: TASK_ID, status: 'in_progress', remote: true }),
      { headers: { 'Hub-Reflect': 'true' } },
    );
  });
});
