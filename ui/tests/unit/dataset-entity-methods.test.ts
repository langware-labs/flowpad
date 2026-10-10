/**
 * A dataset READ BY ID carries an `examples` field on the wire. Assigning the wire row onto the
 * instance used to hide a method of that name, so the dataset editor failed to start with
 * "examples is not a function" -- found in the browser, pinned here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dataset, dataManager } from '@sdk';
import { ExpressionNode } from '@sdk/FlowSync/query';
import type { ActionInfo } from '@sdk/models/ActionInfo';

describe('a dataset built from a wire row keeps its actions', () => {
  it('a wire `examples` field does not hide listing the examples', () => {
    const ds = new Dataset({ id: '6d1a2b3c-4d5e-4f6a-8b7c-9d0e1f2a3b4c', name: 'n', examples: [] } as never);
    expect(typeof ds.listExamples).toBe('function');
    expect(typeof ds.example).toBe('function');
    expect(typeof ds.annotate).toBe('function');
  });
});

/**
 * Reading SOME rows, counting them, and writing many in one step: each method must reach its own
 * action with exactly the parameters the server reads (`flow_sdk/builtin/dataset.py`).
 */
describe('the row actions a dataset client calls', () => {
  const ds = () => new Dataset({ id: '6d1a2b3c-4d5e-4f6a-8b7c-9d0e1f2a3b4c', name: 'n' } as never);
  const spy = (answer: unknown = {}) => vi.spyOn(dataManager, 'callAction').mockResolvedValue(answer as never);
  const sent = (call: ReturnType<typeof spy>) => call.mock.calls[0][0] as ActionInfo;

  afterEach(() => vi.restoreAllMocks());

  it('rows() with no query asks for every row, with no filter at all', async () => {
    const call = spy({ rows: [], total: 0, problems: [] });
    await ds().rows();
    expect(sent(call).name).toBe('rows');
    expect(sent(call).method).toBe('GET');
    expect(sent(call).queryParameters).toEqual({});
  });

  it('rows(query) sends match, order and paging as ONE filter parameter', async () => {
    const call = spy({ rows: [], total: 0, problems: [] });
    const match = { op: '$AND', operands: [{ 'input.metric': 'em_reply' }, { op: '$GE', operands: ['input.day', '2026-09-01'] }] };
    await ds().rows({ match: match as never, order_by: { 'input.day': 'desc' }, limit: 50, offset: 100 });
    const filter = JSON.parse((sent(call).queryParameters as Record<string, string>).filter);
    expect(filter).toEqual({ match, order_by: { 'input.day': 'desc' }, limit: 50, offset: 100 });
  });

  it('rows() keeps limit 0 and offset 0 (they are values, not "unset")', async () => {
    const call = spy({ rows: [], total: 0, problems: [] });
    await ds().rows({ limit: 0, offset: 0 });
    expect(JSON.parse((sent(call).queryParameters as Record<string, string>).filter)).toEqual({ limit: 0, offset: 0 });
  });

  it('rows() serialises an ExpressionNode match', async () => {
    const call = spy({ rows: [], total: 0, problems: [] });
    await ds().rows({ match: new ExpressionNode({ op: '$LIKE', operands: ['input.person', 'levi'] }) });
    expect(JSON.parse((sent(call).queryParameters as Record<string, string>).filter)).toEqual({
      match: { op: '$LIKE', operands: ['input.person', 'levi'] },
    });
  });

  it('count() sends the match and the fields to group by, and answers the server\'s tally', async () => {
    const tally = { total: 4, groups: [{ by: { 'input.metric': 'em_sent' }, count: 4 }] };
    const call = spy(tally);
    const got = await ds().count({ match: { 'input.metric': 'em_sent' }, group_by: ['input.metric', 'input.day'] });
    const params = sent(call).queryParameters as Record<string, string>;
    expect(sent(call).name).toBe('count');
    expect(JSON.parse(params.filter)).toEqual({ match: { 'input.metric': 'em_sent' } });
    expect(JSON.parse(params.group_by)).toEqual(['input.metric', 'input.day']);
    expect(got).toEqual(tally);
  });

  it('count() with nothing asked sends nothing', async () => {
    const call = spy({ total: 0, groups: [] });
    await ds().count();
    expect(sent(call).queryParameters).toEqual({});
  });

  it('putMany() posts the rows, and `expected` only when given', async () => {
    const call = spy({ example_ids: ['a'], keys: ['acme'], num_examples: 1 });
    const rows = [{ key: 'acme', input: { name: 'Acme' } }];
    await ds().putMany(rows);
    expect(sent(call).name).toBe('put-rows');
    expect(sent(call).method).toBe('POST');
    expect(sent(call).bodyParameters).toEqual({ rows });
    await ds().putMany(rows, { expected: { acme: 'v1' } });
    expect((call.mock.calls[1][0] as ActionInfo).bodyParameters).toEqual({ rows, expected: { acme: 'v1' } });
  });

  it('deleteRows() posts the keys, and `expected` only when given', async () => {
    const call = spy({ keys: ['a', 'b'], num_examples: 0 });
    await ds().deleteRows(['a', 'b']);
    expect(sent(call).name).toBe('delete-rows');
    expect(sent(call).bodyParameters).toEqual({ keys: ['a', 'b'] });
    await ds().deleteRows(['a'], { expected: { a: 'v1' } });
    expect((call.mock.calls[1][0] as ActionInfo).bodyParameters).toEqual({ keys: ['a'], expected: { a: 'v1' } });
  });

  it('a refused bulk write surfaces the server\'s refusal to the caller', async () => {
    const refusal = { response: { status: 409, data: { message: 'used by lead dana', data: { details: [{ path: 'acme', code: 'referenced', message: 'used by lead dana' }] } } } };
    vi.spyOn(dataManager, 'callAction').mockRejectedValue(refusal as never);
    await expect(ds().deleteRows(['acme'])).rejects.toBe(refusal);
    await expect(ds().putMany([{ key: 'acme', input: {} }])).rejects.toBe(refusal);
    await expect(ds().sync([])).rejects.toBe(refusal);
  });

  it('sync() posts the rows; prune and match travel only when set', async () => {
    const done = { created: ['c'], updated: [], unchanged: ['a'], deleted: ['b'], num_examples: 2 };
    const call = spy(done);
    const rows = [{ key: 'a', input: { name: 'A' } }, { key: 'c', input: { name: 'C' } }];
    expect(await ds().sync(rows)).toEqual(done);
    expect(sent(call).name).toBe('sync-rows');
    expect(sent(call).bodyParameters).toEqual({ rows });
    await ds().sync(rows, { prune: false, match: { op: '$LIKE', operands: ['key', 'crm_'] } as never });
    expect((call.mock.calls[1][0] as ActionInfo).bodyParameters).toEqual({
      rows,
      prune: false,
      match: { op: '$LIKE', operands: ['key', 'crm_'] },
    });
  });
});
