/**
 * The period a day falls in is keyed the same in the browser as on the server: the bucket cases of
 * `test_fixtures/dataset_count_cases.json` run here against `bucketOf`, and in
 * `tests/unit/test_data_spec/test_dataset_count_cases.py` against `bucket_of` — so a page that
 * labels "the week of 2026-09-13" names the group `count({group_by: ['week:input.day']})` returns.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bucketOf } from '@sdk/entities/dataset';

const fixture = JSON.parse(readFileSync(resolve(__dirname, '../../../test_fixtures/dataset_count_cases.json'), 'utf-8')) as {
  buckets: { day: string | null; unit: 'day' | 'week' | 'month' | 'quarter'; week_start: 'monday' | 'sunday'; key: string | null }[];
};

describe('the period a day falls in', () => {
  it.each(fixture.buckets.map((b) => [`${b.day} ${b.unit} ${b.week_start}`, b] as const))('%s', (_name, b) => {
    expect(bucketOf(b.day, b.unit, b.week_start)).toBe(b.key);
  });

  it('a week begins on Monday unless told otherwise', () => {
    expect(bucketOf('2026-09-13', 'week')).toBe('2026-09-07');
    expect(bucketOf('2026-09-13', 'week', 'sunday')).toBe('2026-09-13');
  });

  it('a day that does not exist is no date', () => {
    expect(bucketOf('2026-02-30', 'month')).toBeNull();
    expect(bucketOf(20260913, 'day')).toBeNull();
  });
});
