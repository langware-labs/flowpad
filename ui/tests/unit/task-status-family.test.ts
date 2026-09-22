import { describe, expect, it } from 'vitest';
import { STATUS_LABELS } from '@src/components/task-bar/constants';
import {
  ALL_TASK_STATUSES,
  isDelegatedTask,
  STATUS_FAMILIES,
  statusFamily,
  TaskStatus,
} from '@src/components/task-bar/task-utils';

// One list, mirrored from flow_sdk/schema/data_spec/task_spec.py STATUS_FAMILY.
describe('task status families', () => {
  it('puts every stored status on the three-bucket board', () => {
    expect(Object.fromEntries(ALL_TASK_STATUSES.map((s) => [s, statusFamily(s)]))).toEqual({
      to_do: 'to_do',
      submitted: 'to_do',
      in_progress: 'in_progress',
      working: 'in_progress',
      input_required: 'in_progress',
      done: 'done',
      failed: 'done',
      canceled: 'done',
    });
  });

  it('reads an unknown or legacy status as New', () => {
    expect(statusFamily('open')).toBe(TaskStatus.TO_DO);
    expect(statusFamily(undefined)).toBe(TaskStatus.TO_DO);
  });

  it('labels every status, and a person sets only the buckets', () => {
    expect(ALL_TASK_STATUSES.filter((s) => !STATUS_LABELS[s])).toEqual([]);
    expect(STATUS_FAMILIES).toEqual(['to_do', 'in_progress', 'done']);
  });

  it('knows a delegated task by its owner', () => {
    expect(isDelegatedTask({ owner: 'subagent:general-worker' } as never)).toBe(true);
    expect(isDelegatedTask({ owner: null } as never)).toBe(false);
  });
});
