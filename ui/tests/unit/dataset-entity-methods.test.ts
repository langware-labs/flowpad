/**
 * A dataset READ BY ID carries an `examples` field on the wire. Assigning the wire row onto the
 * instance used to hide a method of that name, so the dataset editor failed to start with
 * "examples is not a function" -- found in the browser, pinned here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionManager, DATASET_ROWS_CHANGED, DataSource, Dataset, EventBus, dataManager } from '@sdk';
import type { CheckDetail } from '@sdk/entities/dataset';
import { ExpressionNode } from '@sdk/FlowSync/query';
import type { KindForm, KindRule } from '@sdk/viewers/contract';
import { settle } from './watch_test_utils';

describe('a dataset built from a wire row keeps its actions', () => {
  it('a wire `rows` field does not hide reading the rows', () => {
    const ds = new Dataset({ id: '6d1a2b3c-4d5e-4f6a-8b7c-9d0e1f2a3b4c', name: 'n', rows: [] } as never);
    expect(typeof ds.query).toBe('function');
    expect(typeof ds.rowIndex).toBe('function');
    expect(typeof ds.row).toBe('function');
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
  const sent = (call: ReturnType<typeof spy>) => call.mock.calls[0][0];

  afterEach(() => vi.restoreAllMocks());

  it('rows() with no query asks for every row, with no filter at all', async () => {
    const call = spy({ rows: [], total: 0, problems: [] });
    await ds().query();
    expect(sent(call).name).toBe('rows');
    expect(sent(call).method).toBe('GET');
    expect(sent(call).queryParameters).toEqual({});
  });

  it('rows(query) sends match, order and paging as ONE filter parameter', async () => {
    const call = spy({ rows: [], total: 0, problems: [] });
    const match = { op: '$AND', operands: [{ 'input.metric': 'em_reply' }, { op: '$GE', operands: ['input.day', '2026-09-01'] }] };
    await ds().query({ match: match as never, order_by: { 'input.day': 'desc' }, limit: 50, offset: 100 });
    const filter = JSON.parse((sent(call).queryParameters as Record<string, string>).filter);
    expect(filter).toEqual({ match, order_by: { 'input.day': 'desc' }, limit: 50, offset: 100 });
  });

  it('rows() keeps limit 0 and offset 0 (they are values, not "unset")', async () => {
    const call = spy({ rows: [], total: 0, problems: [] });
    await ds().query({ limit: 0, offset: 0 });
    expect(JSON.parse((sent(call).queryParameters as Record<string, string>).filter)).toEqual({ limit: 0, offset: 0 });
  });

  it('rows() serialises an ExpressionNode match', async () => {
    const call = spy({ rows: [], total: 0, problems: [] });
    await ds().query({ match: new ExpressionNode({ op: '$LIKE', operands: ['input.person', 'levi'] }) });
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
    const call = spy({ ids: ['a'], keys: ['acme'], num_rows: 1 });
    const rows = [{ key: 'acme', input: { name: 'Acme' } }];
    await ds().putMany(rows);
    expect(sent(call).name).toBe('put-rows');
    expect(sent(call).method).toBe('POST');
    expect(sent(call).bodyParameters).toEqual({ rows });
    await ds().putMany(rows, { expected: { acme: 'v1' } });
    expect((call.mock.calls[1][0]).bodyParameters).toEqual({ rows, expected: { acme: 'v1' } });
  });

  it('deleteRows() posts the keys, and `expected` only when given', async () => {
    const call = spy({ keys: ['a', 'b'], num_rows: 0 });
    await ds().deleteRows(['a', 'b']);
    expect(sent(call).name).toBe('delete-rows');
    expect(sent(call).bodyParameters).toEqual({ keys: ['a', 'b'] });
    await ds().deleteRows(['a'], { expected: { a: 'v1' } });
    expect((call.mock.calls[1][0]).bodyParameters).toEqual({ keys: ['a'], expected: { a: 'v1' } });
  });

  it('a mirrored row the outside system refused, or a field that cannot go back, reaches the caller as is', async () => {
    for (const code of ['source_refused', 'not_writable']) {
      const refusal = { response: { status: 400, data: { message: code, data: { details: [{ path: '', code, message: code }] } } } };
      vi.spyOn(dataManager, 'callAction').mockRejectedValue(refusal as never);
      await expect(ds().put('t-1', { input: { status: 'DONE' } })).rejects.toBe(refusal);
      await expect(ds().putMany([{ key: 't-1', input: {} }])).rejects.toBe(refusal);
      vi.restoreAllMocks();
    }
  });

  it('a refused bulk write surfaces the server\'s refusal to the caller', async () => {
    const refusal = { response: { status: 409, data: { message: 'used by lead dana', data: { details: [{ path: 'acme', code: 'referenced', message: 'used by lead dana' }] } } } };
    vi.spyOn(dataManager, 'callAction').mockRejectedValue(refusal as never);
    await expect(ds().deleteRows(['acme'])).rejects.toBe(refusal);
    await expect(ds().putMany([{ key: 'acme', input: {} }])).rejects.toBe(refusal);
    await expect(ds().sync([])).rejects.toBe(refusal);
  });

  it('sync() posts the rows; prune and match travel only when set', async () => {
    const done = { created: ['c'], updated: [], unchanged: ['a'], deleted: ['b'], num_rows: 2 };
    const call = spy(done);
    const rows = [{ key: 'a', input: { name: 'A' } }, { key: 'c', input: { name: 'C' } }];
    expect(await ds().sync(rows)).toEqual(done);
    expect(sent(call).name).toBe('sync-rows');
    expect(sent(call).bodyParameters).toEqual({ rows });
    await ds().sync(rows, { prune: false, match: { op: '$LIKE', operands: ['key', 'crm_'] } as never });
    expect((call.mock.calls[1][0]).bodyParameters).toEqual({
      rows,
      prune: false,
      match: { op: '$LIKE', operands: ['key', 'crm_'] },
    });
  });
});

/** Rows changing is an event (`dataset.rows.changed`): an app re-reads when told, not on a timer. */
describe('hearing that rows changed', () => {
  const ID = '6d1a2b3c-4d5e-4f6a-8b7c-9d0e1f2a3b4c';
  const frame = (target: string, data: Record<string, unknown>) =>
    EventBus.deliver({ id: 'e1', timestamp: '2026-10-10T00:00:00Z', tag: DATASET_ROWS_CHANGED, target, data, ctx: { origin: 'local_server' } } as never);

  let connect: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    connect = vi.spyOn(ConnectionManager.getInstance(), 'connect').mockResolvedValue(undefined);
  });
  afterEach(() => {
    EventBus.clear();
    vi.restoreAllMocks();
  });

  it('opens the socket the events arrive on — a served app\'s initSdk() does not', () => {
    new Dataset({ id: ID, name: 'n' } as never).onRowsChanged(() => undefined);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('a socket that cannot open is not an error for the page', async () => {
    connect.mockRejectedValue(new Error('refused'));
    expect(() => new Dataset({ id: ID, name: 'n' } as never).onRowsChanged(() => undefined)).not.toThrow();
    await Promise.resolve();
  });

  it('calls back for this dataset with the keys that moved', () => {
    const heard: unknown[] = [];
    new Dataset({ id: ID, name: 'n' } as never).onRowsChanged((change) => heard.push(change));
    frame(`dataset:${ID}`, { op: 'sync', keys: ['a', 'b'], count: 2 });
    expect(heard).toEqual([{ op: 'sync', keys: ['a', 'b'], count: 2 }]);
  });

  it('does not call back for another dataset, or another tag', () => {
    const heard: unknown[] = [];
    new Dataset({ id: ID, name: 'n' } as never).onRowsChanged((change) => heard.push(change));
    frame('dataset:00000000-0000-4000-8000-000000000000', { op: 'put', keys: ['a'], count: 1 });
    EventBus.deliver({ id: 'e2', timestamp: 't', tag: 'task.done', target: `dataset:${ID}`, data: {}, ctx: { origin: 'local_server' } } as never);
    expect(heard).toEqual([]);
  });

  it('stops when unsubscribed', () => {
    const heard: unknown[] = [];
    const off = new Dataset({ id: ID, name: 'n' } as never).onRowsChanged((change) => heard.push(change));
    off();
    frame(`dataset:${ID}`, { op: 'delete', keys: ['a'], count: 1 });
    expect(heard).toEqual([]);
  });

  it('names the tag the server emits', () => {
    expect(DATASET_ROWS_CHANGED).toBe('dataset.rows.changed');
  });

  /** The event is enough: a write made while the socket was down is told on reconnect, as one
   *  `sync` with no keys — when the rows' version moved past the last one this listener heard or
   *  this instance read. No focus re-read. */
  describe('catching up after the socket was down', () => {
    let offs: Array<() => void> = [];
    afterEach(() => {
      offs.forEach((off) => off());
      offs = [];
    });
    const answer = (version: string) => vi.spyOn(dataManager, 'callAction').mockResolvedValue({ version } as never);
    const listen = async (ds = new Dataset({ id: ID, name: 'n' } as never), version = 'v1') => {
      const call = answer(version);
      const heard: unknown[] = [];
      offs.push(ds.onRowsChanged((c) => heard.push(c)));
      await settle();
      return { call, heard, ds };
    };
    const reconnect = async () => {
      ConnectionManager.getInstance().emit('on_reconnected');
      await settle();
    };

    it('asks the rows version once as a baseline, and says nothing when it has not moved', async () => {
      const { call, heard } = await listen();
      expect(call.mock.calls[0][0].name).toBe('rows-version');
      await reconnect();
      expect(heard).toEqual([]);
    });

    it('tells one sync, with the new version, when the rows moved while away', async () => {
      const { call, heard } = await listen();
      call.mockResolvedValue({ version: 'v2' } as never);
      await reconnect();
      expect(heard).toEqual([{ op: 'sync', keys: [], count: 0, version: 'v2' }]);
      await reconnect();
      expect(heard).toHaveLength(1); // seen now: nothing more to say
    });

    it('a version heard on an event counts as heard, and each listener catches up on its own', async () => {
      const { heard } = await listen();
      frame(`dataset:${ID}`, { op: 'put', keys: ['a'], count: 1, version: 'v2' });
      const { call, heard: other } = await listen(undefined, 'v2'); // joins at v2 (and re-spies the action)
      await reconnect();
      expect(heard).toHaveLength(1); // the event itself; no sync for a version already heard
      expect(other).toEqual([]);
      call.mockResolvedValue({ version: 'v3' } as never);
      await reconnect();
      expect(heard).toHaveLength(2); // both hear the move, each against its own last version
      expect(other).toHaveLength(1);
    });

    it('a version read with rows() counts as seen, whichever came first', async () => {
      const ds = new Dataset({ id: ID, name: 'n' } as never);
      const read = vi.spyOn(dataManager, 'callAction').mockResolvedValue({ rows: [], total: 0, problems: [], version: 'v2' } as never);
      await ds.query(); // read first, then a write lands, then the listener's baseline sees v3
      read.mockRestore();
      const { call, heard } = await listen(ds, 'v3');
      expect(heard).toEqual([{ op: 'sync', keys: [], count: 0, version: 'v3' }]); // the write between
      call.mockResolvedValue({ rows: [], total: 0, problems: [], version: 'v4' } as never);
      await ds.query(); // the page re-read: v4 is seen
      call.mockResolvedValue({ version: 'v4' } as never);
      await reconnect();
      expect(heard).toHaveLength(1); // nothing moved since the read
    });

    it('a page over many datasets holds ONE reconnect listener, and every dataset still catches up', async () => {
      const connection = ConnectionManager.getInstance();
      const before = connection.listenerCount('on_reconnected');
      const call = answer('v1');
      const heard: string[] = [];
      for (let n = 0; n < 12; n += 1) {
        const ds = new Dataset({ id: `0000000${n.toString(16)}-0000-4000-8000-000000000000`, name: `d${n}` } as never);
        offs.push(ds.onRowsChanged(() => heard.push(ds.id)));
      }
      await settle();
      expect(connection.listenerCount('on_reconnected') - before).toBeLessThanOrEqual(1);
      call.mockResolvedValue({ version: 'v2' } as never);
      await reconnect();
      expect(new Set(heard).size).toBe(12);
    });

    it('stops checking when unsubscribed, and a server that is away is not an error', async () => {
      const { call, heard } = await listen();
      call.mockRejectedValue(new Error('away'));
      await reconnect();
      offs.pop()!();
      call.mockResolvedValue({ version: 'v9' } as never);
      await reconnect();
      expect(heard).toEqual([]);
    });
  });
});

/** A field an outside system owns (`owned_by` in the schema) is set only by a writer that says it
 *  writes as that owner: `by` travels on every write and on `check`, and only when given. */
describe('writing as the owner of outside-owned fields', () => {
  const ds = () => new Dataset({ id: '6d1a2b3c-4d5e-4f6a-8b7c-9d0e1f2a3b4c', name: 'n' } as never);
  const rows = [{ key: 'a', input: { name: 'A' } }];
  let call: ReturnType<typeof vi.spyOn>;
  const body = (n = 0) => (call.mock.calls[n][0] as { bodyParameters: Record<string, unknown> }).bodyParameters;

  beforeEach(() => {
    call = vi.spyOn(dataManager, 'callAction').mockResolvedValue({} as never);
  });
  afterEach(() => vi.restoreAllMocks());

  it('put, putMany, sync, append and check carry `by` when given', async () => {
    await ds().put('a', { input: { name: 'A' } }, { expected: 'v1', by: 'crm' });
    await ds().putMany(rows, { by: 'crm' });
    await ds().sync(rows, { prune: false, by: 'crm' });
    await ds().append(rows, { by: 'crm' });
    await ds().check({ key: 'a', input: { name: 'A' } }, { by: 'crm' });
    expect(body(0)).toEqual({ key: 'a', row: { input: { name: 'A' } }, expected: 'v1', by: 'crm' });
    expect(body(1)).toEqual({ rows, by: 'crm' });
    expect(body(2)).toEqual({ rows, prune: false, by: 'crm' });
    expect(body(3)).toEqual({ rows, by: 'crm' });
    expect(body(4)).toEqual({ row: { key: 'a', input: { name: 'A' } }, by: 'crm' });
  });

  it('an app editing its own fields sends no `by`', async () => {
    await ds().put('a', { input: { name: 'A' } });
    await ds().putMany(rows);
    await ds().sync(rows);
    await ds().append(rows);
    await ds().check({ input: { name: 'A' } });
    for (let n = 0; n < 5; n++) expect(body(n)).not.toHaveProperty('by');
  });

  it('a refusal says which field is owned, and by whom', async () => {
    const refusal = {
      response: { status: 400, data: { data: { details: [{ path: 'input.stage', code: 'owned', owned_by: 'crm', message: 'stage is owned by crm' }] } } },
    };
    call.mockRejectedValue(refusal as never);
    const caught = await ds()
      .put('a', { input: { stage: 'won' } })
      .catch((error: typeof refusal) => error);
    const detail: CheckDetail = (caught as typeof refusal).response.data.data.details[0];
    expect([detail.code, detail.owned_by]).toEqual(['owned', 'crm']);
  });
});

/** What a kind's form says beyond shapes: who owns a field, and the rules across rows. */
describe('a kind form carries owners and both kinds of rule', () => {
  it('a field may name its owner; a rule is `same` or `unique`', () => {
    const form: KindForm = {
      kind: '--acme--.crm.deal',
      subkind: 'record',
      fields: { stage: { shape: 'enum:open|won', required: true, owned_by: 'crm' }, notes: { shape: '?string' } },
      rules: [
        { same: ['persona.icp', 'icp'], description: '' },
        { unique: ['crm_id'], description: 'one row per CRM record' },
      ],
    };
    const readOnly = Object.entries(form.fields ?? {}).filter(([, field]) => field.owned_by).map(([name]) => name);
    const unique = (form.rules ?? []).flatMap((rule: KindRule) => rule.unique ?? []);
    expect(readOnly).toEqual(['stage']);
    expect(unique).toEqual(['crm_id']);
  });
});

/** Reads that cross links, count more than rows, and read text — each option reaches the server
 *  exactly as `Dataset._query_params` reads it. */
describe('asking more of rows and count', () => {
  const ds = () => new Dataset({ id: '6d1a2b3c-4d5e-4f6a-8b7c-9d0e1f2a3b4c', name: 'n' } as never);
  let call: ReturnType<typeof vi.spyOn>;
  const sent = (n = 0) => call.mock.calls[n][0] as { name: string; method: string; queryParameters: Record<string, string> };

  beforeEach(() => {
    call = vi.spyOn(dataManager, 'callAction').mockResolvedValue({} as never);
  });
  afterEach(() => vi.restoreAllMocks());

  it('rows() sends link paths to expand inside the filter, and q beside it', async () => {
    await ds().query({ match: { 'input.persona.icp.key': 'fintech' }, expand: ['input.persona', 'input.messages.*'], q: 'pricing objection' });
    expect(JSON.parse(sent().queryParameters.filter)).toEqual({
      match: { 'input.persona.icp.key': 'fintech' },
      expand: ['input.persona', 'input.messages.*'],
    });
    expect(sent().queryParameters.q).toBe('pricing objection');
  });

  it('a join on a value travels as a sub-query the server answers', async () => {
    const replied = { op: '$PROP', operands: ['input.email', { 'input.metric': 'em_reply' }] };
    const match = { op: '$AND', operands: [{ 'input.metric': 'em_mtg' }, { op: '$IN', operands: ['input.email', replied] }] };
    await ds().query({ match: match as never });
    expect(JSON.parse(sent().queryParameters.filter)).toEqual({ match });
    await ds().query({ match: new ExpressionNode(match) });                       // ... and as an ExpressionNode
    expect(JSON.parse(sent(1).queryParameters.filter).match.operands[1].operands[1]).toEqual({
      op: '$PROP',
      operands: ['input.email', { op: '$EQ', operands: ['input.metric', 'em_reply'] }],
    });
  });

  it('rows() answers the linked rows the server put beside', async () => {
    const linked = { 'crm.co.id.1': { dataset_id: 'd', key: 'acme', row: { key: 'acme', input: { name: 'Acme' } } } };
    call.mockResolvedValue({ rows: [], total: 0, problems: [], linked } as never);
    expect((await ds().query({ expand: ['input.company'] })).linked).toEqual(linked);
  });

  it('a blank q and an empty expand are not sent', async () => {
    await ds().query({ q: '   ', expand: [] });
    expect(sent().queryParameters).toEqual({});
  });

  it('count() sends buckets, metrics, order and the week start', async () => {
    await ds().count({
      match: { 'input.metric': 'em_reply' },
      q: 'levi',
      group_by: ['week:input.day', 'input.metric'],
      metrics: { people: 'distinct:input.email', first: 'min:input.day' },
      order_by: { 'week:input.day': 'asc' },
      week_start: 'sunday',
    });
    const p = sent().queryParameters;
    expect(sent().name).toBe('count');
    expect(JSON.parse(p.filter)).toEqual({ match: { 'input.metric': 'em_reply' } });
    expect(p.q).toBe('levi');
    expect(JSON.parse(p.group_by)).toEqual(['week:input.day', 'input.metric']);
    expect(JSON.parse(p.metrics)).toEqual({ people: 'distinct:input.email', first: 'min:input.day' });
    expect(JSON.parse(p.order_by)).toEqual({ 'week:input.day': 'asc' });
    expect(p.week_start).toBe('sunday');
  });

  it('count() with only a match sends nothing else', async () => {
    await ds().count({ match: { 'input.metric': 'em_sent' } });
    expect(Object.keys(sent().queryParameters)).toEqual(['filter']);
  });

  it('usedBy() asks who links to the rows, and answers the map', async () => {
    const used_by = { acme: [{ dataset_id: 'd', kind: 'crm.lead', key: 'dana' }], bolt: [] };
    call.mockResolvedValue({ used_by } as never);
    expect(await ds().usedBy(['acme', 'bolt'])).toEqual(used_by);
    expect([sent().name, sent().method, sent().queryParameters]).toEqual(['used-by', 'GET', { keys: 'acme,bolt' }]);
    await ds().usedBy();
    expect(sent(1).queryParameters).toEqual({});
  });
});

/** A system of record through a data source: its items mirrored as typed rows, and an app-owned
 *  field written back through the source's driver — never a client or a key in the frame. */
describe('mirroring a data source and writing back through it', () => {
  let call: ReturnType<typeof vi.spyOn>;
  const sent = (n = 0) => call.mock.calls[n][0] as { name: string; method: string; bodyParameters: Record<string, unknown> };

  beforeEach(() => {
    call = vi.spyOn(dataManager, 'callAction').mockResolvedValue({} as never);
  });
  afterEach(() => vi.restoreAllMocks());

  it('mirror() posts the source and the map; by / prune / match only when given', async () => {
    const ds = new Dataset({ id: '6d1a2b3c-4d5e-4f6a-8b7c-9d0e1f2a3b4c', name: 'n' } as never);
    const map = { key: 'external_id', input: { name: 'name', stage: 'data.stage' } };
    await ds.mirror('src-1', map);
    expect([sent().name, sent().method, sent().bodyParameters]).toEqual(['mirror', 'POST', { source_id: 'src-1', map }]);
    await ds.mirror('src-1', map, { by: 'crm', prune: false, match: { 'input.source': 'crm' } });
    expect(sent(1).bodyParameters).toEqual({ source_id: 'src-1', map, by: 'crm', prune: false, match: { 'input.source': 'crm' } });
  });

  it('createItem() asks the source to make a record in its own system, and answers the record kept here', async () => {
    const source = new DataSource({ id: '7e2b3c4d-1111-4a5b-8c9d-0e1f2a3b4c5d', name: 'CRM' } as never);
    const answer = { item_id: 'i9', origin: { kind: 'record', namespace: 'crm', key: 'OPP-9' }, status: 'created' };
    call.mockResolvedValue(answer as never);
    expect(await source.createItem({ title: 'Call Acme back' })).toEqual(answer);
    expect([sent().name, sent().method, sent().bodyParameters]).toEqual(['create_item', 'POST', { data: { title: 'Call Acme back' } }]);
  });

  it('updateItem() and deleteItem() ask the source to write to its own system', async () => {
    const source = new DataSource({ id: '7e2b3c4d-5e6f-4a7b-9c8d-0e1f2a3b4c5d', name: 'CRM' } as never);
    const answer = { item_id: 'i1', origin: { kind: 'record', namespace: 'crm', key: 'OPP-1' }, status: 'updated' };
    call.mockResolvedValue(answer as never);
    expect(await source.updateItem('i1', { gtmPersona: 'cfo' })).toEqual(answer);
    expect([sent().name, sent().bodyParameters]).toEqual(['update_item', { item_id: 'i1', changes: { gtmPersona: 'cfo' } }]);
    await source.deleteItem('i1');
    expect([sent(1).name, sent(1).bodyParameters]).toEqual(['delete_item', { item_id: 'i1' }]);
  });

  it('a refused write-back reaches the caller (a read-only source, a driver that cannot)', async () => {
    const refusal = { response: { status: 403, data: { message: 'this source is read-only' } } };
    call.mockRejectedValue(refusal as never);
    await expect(new DataSource({ id: '7e2b3c4d-5e6f-4a7b-9c8d-0e1f2a3b4c5d', name: 'CRM' } as never).updateItem('i1', { x: 1 })).rejects.toBe(refusal);
  });
});
