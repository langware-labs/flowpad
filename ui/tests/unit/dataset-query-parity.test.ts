/**
 * The row-query expression answers the same in TypeScript and in Python. ONE table of cases —
 * `test_fixtures/dataset_query_cases.json` — is run here against `QueryFilter.validate` and in
 * `tests/unit/test_data_spec/test_dataset_query.py` against `flow_sdk.datasets.query.matches`:
 * a row a live query keeps in the browser is a row the server would answer, and the reverse.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { QueryFilter, fieldOf } from '@sdk/FlowSync/query';

const fixture = JSON.parse(readFileSync(resolve(__dirname, '../../../test_fixtures/dataset_query_cases.json'), 'utf-8')) as {
  row: Record<string, unknown>;
  cases: { name: string; match: Record<string, unknown>; passes: boolean }[];
};

describe('the shared row-query cases', () => {
  it.each(fixture.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(new QueryFilter({ match: c.match as never }).validate(fixture.row)).toBe(c.passes);
  });

  it('has cases to run', () => {
    expect(fixture.cases.length).toBeGreaterThan(20);
  });
});

describe('a field is a path', () => {
  it('a key written with a dot wins over the walk', () => {
    expect(fieldOf({ 'a.b': 1, a: { b: 2 } }, 'a.b')).toBe(1);
    expect(fieldOf({ a: { b: 2 } }, 'a.b')).toBe(2);
  });

  it('a path that leads nowhere is undefined, never an error', () => {
    expect(fieldOf({ a: [10, 20] }, 'a.5')).toBeUndefined();
    expect(fieldOf({ a: 3 }, 'a.b.c')).toBeUndefined();
    expect(fieldOf(null, 'a')).toBeUndefined();
    expect(fieldOf({ a: 1 }, 7)).toBeUndefined();
  });

  it('a flat entity field still reads as before', () => {
    expect(new QueryFilter({ match: { status: 'open' } }).validate({ status: 'open' })).toBe(true);
    expect(new QueryFilter({ match: { status: 'open' } }).validate({ status: 'done' })).toBe(false);
  });
});
