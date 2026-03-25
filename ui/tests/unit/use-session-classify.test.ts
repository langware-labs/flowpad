import { describe, expect, it } from 'vitest';
import { getClassificationInfo } from '@src/components/task-bar/task-utils';

// ---------- getClassificationInfo edge cases ----------

describe('getClassificationInfo', () => {
  it('returns null for task with no metadata', () => {
    const task = { task_type: 'classification' } as any;
    expect(getClassificationInfo(task)).toBeNull();
  });

  it('returns null for task with empty metadata', () => {
    const task = { task_type: 'classification', metadata: {} } as any;
    expect(getClassificationInfo(task)).toBeNull();
  });

  it('returns classification when metadata has all fields', () => {
    const task = {
      task_type: 'classification',
      metadata: {
        classification_category: 'memory',
        classification_title: 'Always use bun',
        classification_command: 'create-memory',
      },
    } as any;
    expect(getClassificationInfo(task)).toEqual({
      category: 'memory',
      title: 'Always use bun',
      command: 'create-memory',
    });
  });

  it('returns null for non-classification task type', () => {
    const task = {
      task_type: 'analysis',
      metadata: {
        classification_category: 'memory',
        classification_title: 'test',
        classification_command: 'create-memory',
      },
    } as any;
    expect(getClassificationInfo(task)).toBeNull();
  });

  it('returns null when metadata fields are wrong types', () => {
    const task = {
      task_type: 'classification',
      metadata: {
        classification_category: 42,
        classification_title: 'test',
        classification_command: 'create-memory',
      },
    } as any;
    expect(getClassificationInfo(task)).toBeNull();
  });
});
