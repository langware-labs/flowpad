// The eval browser's drill-down state, and the eval viewers' pure helpers: issues by cause, gold diff, help.
import { describe, expect, it } from 'vitest';

import { inScope, readState, writeState } from '../../../ts_sdk/src/apps/eval-browser';
import { byCause, columnHelp, formatMetric, issueGroups } from '../../../ts_sdk/src/viewers/eval';
import { goldDiff } from '../../../ts_sdk/src/viewers/generic';
import type { EvalExampleRow, Verdict } from '../../../ts_sdk/src/evals/types';

const ex = (id: string, verdict: Verdict, labels: Record<string, string> = {}, slice: Record<string, string> = {}): EvalExampleRow => ({
  example_id: id,
  prediction: null,
  golds: [],
  verdict,
  score: null,
  latency_ms: 0,
  error: null,
  labels,
  slice,
  title: id,
});

const EXAMPLES = [
  ex('a', 'correct', {}, { 'data.group': 'A' }),
  ex('b', 'wrong', { did: '/dock/tasks', opens: 'yes' }, { 'data.group': 'A' }),
  ex('c', 'wrong', { did: '/dock/tasks' }, { 'data.group': 'B' }),
  ex('d', 'abstained', { feasible: 'no' }, { 'data.group': 'B' }),
];

describe('drill-down state lives in the URL', () => {
  it('round-trips and keeps the host params', () => {
    const search = writeState('?subject=dataset-1&theme=dark', { run: 'r1', slice: 'data.group=D. Assets, by type', cause: 'did=/dock/x' });
    expect(new URLSearchParams(search).get('subject')).toBe('dataset-1');
    expect(readState(search)).toEqual({ run: 'r1', slice: 'data.group=D. Assets, by type', cause: 'did=/dock/x' });
  });

  it('clears a level that is left', () => {
    expect(readState(writeState('?subject=s&run=r&example=e', { run: 'r' }))).toEqual({ run: 'r' });
  });
});

describe('scope and issues', () => {
  it('a slice and a verdict narrow the examples', () => {
    expect(inScope(EXAMPLES, { slice: 'data.group=B' }).map((e) => e.example_id)).toEqual(['c', 'd']);
    expect(inScope(EXAMPLES, { verdict: 'wrong' }).map((e) => e.example_id)).toEqual(['b', 'c']);
  });

  it('groups the issues by each label they carry, biggest first; a correct example is no issue', () => {
    const groups = issueGroups(EXAMPLES);
    expect(groups[0]).toMatchObject({ cause: 'did=/dock/tasks' });
    expect(groups[0].examples.map((e) => e.example_id)).toEqual(['b', 'c']);
    expect(groups.map((g) => g.cause).sort()).toEqual(['did=/dock/tasks', 'feasible=no', 'opens=yes']);
  });

  it('a cause selects its issues; no cause is every issue', () => {
    expect(byCause(EXAMPLES, 'feasible=no').map((e) => e.example_id)).toEqual(['d']);
    expect(byCause(EXAMPLES).map((e) => e.example_id)).toEqual(['b', 'c', 'd']);
  });
});

describe('gold vs prediction', () => {
  it('compares field by field; a field the gold leaves unset is free', () => {
    const rows = goldDiff(
      { route: 'quick', target: { kind: 'view', value: 'assets/list/task' } },
      { route: 'quick', target: { kind: 'view', value: 'tasks' }, confidence: 1 },
    );
    expect(Object.fromEntries(rows.map((r) => [r.path, r.differs]))).toEqual({
      confidence: false,
      route: false,
      'target.kind': false,
      'target.value': true,
    });
  });
});

describe('metrics', () => {
  it('a count reads as a count, a ratio as a percentage — as the backend says, never guessed', () => {
    expect(formatMetric(7, true)).toBe('7');
    expect(formatMetric(1, true)).toBe('1');
    expect(formatMetric(1)).toBe('100.0%');
    expect(formatMetric(0.875)).toBe('87.5%');
    expect(formatMetric(null)).toBe('—');
  });
});

describe('column tooltips', () => {
  it("an eval's own words for its metric win; the browser explains its own columns; a slice path is described", () => {
    expect(columnHelp('precision', { precision: 'when it acts, how often it is right' })).toBe('when it acts, how often it is right');
    expect(columnHelp('accuracy')).toMatch(/share answered right/);
    expect(columnHelp('data.group')).toMatch(/split by "data.group"/);
    expect(columnHelp('something_unknown')).toBeUndefined();
  });
});
